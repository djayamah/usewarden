/**
 * A quote- and heredoc-aware LEXER for shell text. Not an interpreter, not a full parser.
 *
 * WHY THIS EXISTS, AND WHY IT DID NOT UNTIL NOW.
 *
 * D-139 and D-247 both deferred real shell parsing, on the grounds that a half-parser wrong in
 * the PERMISSIVE direction is worse than the annoyance it removes. That reasoning was right and
 * it still is. What changed is the evidence: every false positive left in the labelled corpus
 * after the August fixes is the same defect, and it is a defect a lexer fixes and a regex cannot.
 *
 *   - 12 blocks fired because a heredoc body written with a QUOTED delimiter contained a markdown
 *     code span, and a backtick was read as command substitution. POSIX §2.7.4 is explicit that
 *     when "any part of word is quoted ... the here-document lines shall not be expanded". Inside
 *     `<<'PY'` a backtick is a literal backtick. The guard was not being cautious; it was
 *     contradicting the shell it claims to model.
 *   - 2 blocks fired because `cat > scripts/restore-check.sh <<'SHEOF'` was read as naming a
 *     shell interpreter. It names a FILE. POSIX §2.9.1.1: "the first field shall be considered
 *     the command name" — a `.sh` suffix on an argument is not a command.
 *   - 8 blocks fired on text inside a quoted word. POSIX §2.3: single-quotes "preserve the
 *     literal value of each character within".
 *
 * So the question this module answers is deliberately small: **for a given offset in a command,
 * is it in a command position, an argument, a quoted word, or a here-document body?** That is
 * lexing, not parsing — no expansion, no evaluation, no control flow, nothing executed, ever.
 *
 * WHY NOT A LIBRARY. Researched 2026-09-08; the reasoning is in docs/DEPENDENCY-BUDGET.md.
 * `shell-quote` is a word splitter with no here-document support, which is the class that matters
 * most here. `sh-syntax` is a WASM wrapper around mvdan/sh — correct and complete, and a WASM blob
 * instantiated on every hook event, in a product whose own release workflow cites supply-chain
 * compromise as the reason it stages rather than publishes. `tree-sitter-bash` needs node-gyp.
 * A dependency on the hook path is a cost this product's own argument will not carry.
 *
 * IT FAILS CLOSED, AND THAT IS THE WHOLE SAFETY ARGUMENT. Anything this lexer does not understand
 * — an unbalanced quote, an unterminated here-document, a construct it cannot segment — sets
 * `ok: false`, and every caller is required to fall back to matching the raw string exactly as it
 * did before. A lexer that says "I do not know" is a lexer that cannot open a hole; the failure
 * D-139 feared is a lexer that guesses.
 */

/** How a word was quoted. `mixed` is `a"b"c` - partly quoted, so treated as unquoted. */
export type Quoting = 'none' | 'single' | 'double' | 'mixed';

export interface Word {
  /** The word as written, quotes included. */
  raw: string;
  /** Offset of the first character in the source command. */
  start: number;
  /** Offset one past the last character. */
  end: number;
  quoting: Quoting;
  /**
   * True when this word is the COMMAND NAME of its statement - the first field that is not a
   * variable assignment or a redirection (POSIX §2.9.1.1).
   */
  commandPosition: boolean;
  /**
   * True when the word contains a command substitution — `$(...)` or backticks.
   *
   * THIS FLAG IS A SAFETY INTERLOCK, not information. `grep "$(rm -rf /)" file` has `grep` in
   * command position and a quoted argument, and every rule about inert commands carrying text
   * would say that argument is data. It is not: the substitution runs before grep is even
   * invoked. So a word carrying an expansion is never blanked by `executableText`, and the deny
   * patterns see it exactly as written.
   *
   * `${VAR}` is deliberately NOT an expansion for this purpose. It interpolates a value; it does
   * not run a command.
   */
  hasExpansion: boolean;
}

export interface HeredocSpan {
  /** Offset of the first character of the BODY (the line after the opener). */
  bodyStart: number;
  /** Offset one past the last character of the body, i.e. the start of the delimiter line. */
  bodyEnd: number;
  delimiter: string;
  /**
   * True for `<<'EOF'` and `<<"EOF"`, false for `<<EOF`.
   *
   * POSIX §2.7.4: with a quoted delimiter the body is NOT expanded - no parameter expansion, no
   * command substitution, no arithmetic. A backtick or a `$(...)` in such a body is literal text.
   * With an unquoted delimiter all three happen, so the body really can run a command and this
   * flag is what keeps that case failing closed.
   */
  delimiterQuoted: boolean;
  /** The full text of the line that opened it, for asking what will consume the body. */
  openerLine: string;
  /**
   * Offset one past the delimiter LINE.
   *
   * `bodyEnd` stops at the start of the delimiter line, because that is where the body ends and
   * callers that extract the body want exactly that. The walker needs to skip one line further,
   * or the lone `EOF` gets lexed as a word in command position - shell punctuation reported as a
   * program nobody ran.
   */
  spanEnd: number;
}

export interface Lex {
  /** False means the lexer did not understand the input. Callers MUST fall back. */
  ok: boolean;
  /** Why, when `ok` is false. */
  reason?: string;
  words: Word[];
  heredocs: HeredocSpan[];
}

const WHITESPACE = /\s/;
/** Characters that end a word and start a new statement or redirection. */
const OPERATOR_START = new Set(['&', '|', ';', '<', '>', '(', ')']);

/**
 * Lexes a command line into words and here-document spans.
 *
 * Deliberately NOT handled, each of which sets `ok: false` rather than being approximated:
 * command substitution `$(...)` and backticks in unquoted text (they contain a whole new command
 * this lexer would have to recurse into), process substitution `<(...)`, and any unbalanced
 * quote or unterminated here-document.
 */
export function lex(cmd: string): Lex {
  const words: Word[] = [];
  const heredocs: HeredocSpan[] = [];
  const fail = (reason: string): Lex => ({ ok: false, reason, words, heredocs });

  // Here-document bodies are located first, because they are not part of the token stream at all:
  // POSIX §2.7.4 treats the body as "a single word" delivered on the lines AFTER the opener. A
  // lexer that walked them as ordinary text would see file contents as commands, which is the
  // original defect.
  const lines = cmd.split('\n');
  const lineStart: number[] = [];
  { let p = 0; for (const l of lines) { lineStart.push(p); p += l.length + 1; } }

  const bodyLines = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (bodyLines.has(i)) continue;
    const line = lines[i] ?? '';
    // `<<` or `<<-`, then an optionally quoted delimiter word. `<<<` is a here-STRING and has no
    // body, so it is excluded explicitly rather than by luck.
    const m = /<<(?!<)(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(line);
    if (!m) continue;
    const dashed = m[1] === '-';
    const delimiter = m[3]!;
    const delimiterQuoted = m[2] !== '';
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      // `<<-` strips leading TABS from the delimiter line (POSIX §2.7.4); plain `<<` requires the
      // delimiter alone on the line. Trimming unconditionally would accept a delimiter that the
      // shell would not, which errs permissive - so the two cases are kept apart.
      const cand = lines[j] ?? '';
      const matches = dashed ? cand.replace(/^\t+/, '') === delimiter : cand === delimiter;
      if (matches) { end = j; break; }
    }
    if (end === -1) return fail(`unterminated here-document <<${delimiter}`);
    heredocs.push({
      bodyStart: lineStart[i + 1] ?? cmd.length,
      bodyEnd: lineStart[end] ?? cmd.length,
      delimiter,
      delimiterQuoted,
      openerLine: line,
      spanEnd: (lineStart[end + 1] ?? cmd.length),
    });
    for (let j = i + 1; j <= end; j++) bodyLines.add(j);
  }

  // Now walk the token stream, skipping here-document bodies entirely.
  let i = 0;
  let wordStart = -1;
  let quoting: Quoting = 'none';
  let sawQuote = false;
  let sawBare = false;
  let sawExpansion = false;
  let atCommandPosition = true;

  const flush = (endOff: number): void => {
    if (wordStart < 0) return;
    const raw = cmd.slice(wordStart, endOff);
    const q: Quoting = sawQuote && sawBare ? 'mixed' : quoting;
    // A leading `VAR=value` assignment does not consume the command position (POSIX §2.9.1.1),
    // so `FOO=bar rm -rf /` still has `rm` as its command name. This is load-bearing: the sudo
    // rule's own comment records that env-assignment prefixes were a real evasion shape.
    const isAssignment = q === 'none' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(raw);
    words.push({
      raw, start: wordStart, end: endOff, quoting: q,
      commandPosition: atCommandPosition && !isAssignment,
      hasExpansion: sawExpansion,
    });
    if (atCommandPosition && !isAssignment) atCommandPosition = false;
    wordStart = -1; quoting = 'none'; sawQuote = false; sawBare = false; sawExpansion = false;
  };

  while (i < cmd.length) {
    const body = heredocs.find((h) => i >= h.bodyStart && i < h.spanEnd);
    if (body) { flush(i); i = body.spanEnd; continue; }

    const c = cmd[i]!;

    if (c === '\\') {
      // A backslash-newline is a line continuation and vanishes; anything else is a literal
      // character and keeps the word going.
      if (cmd[i + 1] === '\n') { i += 2; continue; }
      if (wordStart < 0) { wordStart = i; }
      sawBare = true;
      i += 2;
      continue;
    }

    if (c === "'" || c === '"') {
      // Single quotes are literal throughout (POSIX §2.3), so the span ends at the next quote.
      // Double quotes may contain `$(...)` or backticks, and those may themselves contain quotes —
      // `"$(echo "hi")"` — so the close is found by a scan that understands nesting rather than by
      // indexOf, which would have closed the outer quote on the inner one and shifted every word
      // boundary after it.
      const close = c === "'" ? cmd.indexOf(c, i + 1) : findDoubleQuoteEnd(cmd, i + 1, heredocs);
      if (close === -1) return fail(`unbalanced ${c === "'" ? 'single' : 'double'} quote`);
      if (c === '"' && /\$\(|`/.test(cmd.slice(i + 1, close))) sawExpansion = true;
      if (wordStart < 0) wordStart = i;
      const thisQuote: Quoting = c === "'" ? 'single' : 'double';
      // `'a'"b"` is quoted throughout but by two different quotes; it is still all literal for our
      // purposes, so it stays whichever it was rather than becoming `mixed`. `mixed` is reserved
      // for a word that is PARTLY bare, which is the case that can hide an unquoted operator.
      quoting = sawQuote ? quoting : thisQuote;
      sawQuote = true;
      i = close + 1;
      continue;
    }

    // A command substitution in bare text is a whole nested command. It is SPANNED rather than
    // refused: the word it belongs to is flagged, never blanked, and the deny patterns still see
    // its text verbatim. Refusing the whole line here was the first implementation and it made the
    // lexer bail on ordinary things like `T=$(mktemp -d)`, which then disabled every fix in this
    // file for the command that contained it.
    if (c === '`') {
      const close = cmd.indexOf('`', i + 1);
      if (close === -1) return fail('unbalanced backtick');
      if (wordStart < 0) wordStart = i;
      sawBare = true; sawExpansion = true;
      i = close + 1;
      continue;
    }
    if (c === '$' && cmd[i + 1] === '(') {
      const close = findParenEnd(cmd, i + 2, heredocs);
      if (close === -1) return fail('unbalanced command substitution');
      if (wordStart < 0) wordStart = i;
      sawBare = true; sawExpansion = true;
      i = close + 1;
      continue;
    }
    if (c === '<' && cmd[i + 1] === '(') return fail('process substitution');
    if (c === '>' && cmd[i + 1] === '(') return fail('process substitution');

    if (WHITESPACE.test(c)) { flush(i); i++; continue; }

    if (OPERATOR_START.has(c)) {
      flush(i);
      // `&&`, `||`, `;`, `|`, `(`, `)` and a newline all begin a new statement, so the next word
      // is a command name again. A redirection (`<`, `>`, `>>`, `2>`) does NOT: it takes a
      // filename and the command position is unchanged.
      const isRedirect = c === '<' || c === '>';
      if (!isRedirect) atCommandPosition = true;
      // Consume the operator and any second character of a two-character operator.
      i += (cmd[i + 1] === c || (c === '>' && cmd[i + 1] === '&') ? 2 : 1);
      continue;
    }

    if (wordStart < 0) wordStart = i;
    sawBare = true;
    i++;
  }
  flush(cmd.length);

  // A newline is whitespace to the loop above, so statements separated only by newlines would
  // have run together in command position. Recompute from scratch on the raw offsets instead of
  // patching it in the loop, because getting this subtly wrong is how a lexer starts lying.
  markCommandPositions(cmd, words, heredocs);

  return { ok: true, words, heredocs };
}

/**
 * Recomputes `commandPosition` using statement boundaries, including newlines.
 *
 * Separated out because the main loop treats a newline as ordinary whitespace (it has to: a word
 * can be followed by a newline and still be an argument of nothing). A statement starts at the
 * beginning of the string and after any of `; & | && || newline ( )` that is NOT inside a word.
 */
function markCommandPositions(cmd: string, words: Word[], heredocs: HeredocSpan[]): void {
  const boundaries: number[] = [0];
  for (let i = 0; i < cmd.length; i++) {
    if (heredocs.some((h) => i >= h.bodyStart && i < h.spanEnd)) continue;
    const inWord = words.find((w) => i >= w.start && i < w.end);
    if (inWord) { i = inWord.end - 1; continue; }
    const c = cmd[i]!;
    // A backslash-newline is a LINE CONTINUATION and joins two lines into one command (POSIX
    // §2.2.1). Treating it as a boundary made every continued line of
    // `printf '%s\n' \ / 'a' \ / 'b'` look like a new command, so each quoted line was read as a
    // program name rather than as an argument printf carries.
    if (c === '\\' && cmd[i + 1] === '\n') { i++; continue; }
    if (c === '\n' || c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
      boundaries.push(i + 1);
    }
  }
  let bi = 0;
  let expectCommand = true;
  for (const w of words) {
    while (bi < boundaries.length && boundaries[bi]! <= w.start) { expectCommand = true; bi++; }
    const isAssignment = w.quoting === 'none' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.raw);
    w.commandPosition = expectCommand && !isAssignment;
    if (expectCommand && !isAssignment) expectCommand = false;
  }
}

/**
 * Finds the `"` that closes a double-quoted span opened at `from`.
 *
 * Honours `$(...)` and backtick nesting (both of which may contain their own quotes), backslash
 * escapes, and HERE-DOCUMENT BODIES.
 *
 * The heredoc skip is what makes `git commit -m "$(cat <<'MSG' ... MSG)"` lex at all, and that
 * shape is not exotic — it is how an agent writes a long commit message, and it accounted for two
 * of the last false positives in the corpus. The body is arbitrary prose: it will contain
 * apostrophes, unmatched quotes and stray parentheses, and a scanner that read them as syntax
 * closed the outer quote in the wrong place and reported the whole command unparseable.
 * Bodies are located line-wise before any of this runs, so skipping them is exact rather than a
 * guess.
 */
function findDoubleQuoteEnd(cmd: string, from: number, heredocs: readonly HeredocSpan[]): number {
  let i = from;
  while (i < cmd.length) {
    const skip = heredocs.find((h) => i >= h.bodyStart && i < h.spanEnd);
    if (skip) { i = skip.spanEnd; continue; }
    const c = cmd[i]!;
    if (c === '\\') { i += 2; continue; }
    if (c === '"') return i;
    if (c === '`') { const e = cmd.indexOf('`', i + 1); if (e === -1) return -1; i = e + 1; continue; }
    if (c === '$' && cmd[i + 1] === '(') {
      const e = findParenEnd(cmd, i + 2, heredocs);
      if (e === -1) return -1;
      i = e + 1; continue;
    }
    i++;
  }
  return -1;
}

/** Finds the `)` closing a `$(` opened before `from`, honouring nesting, quotes and heredocs. */
function findParenEnd(cmd: string, from: number, heredocs: readonly HeredocSpan[]): number {
  let depth = 1;
  let i = from;
  while (i < cmd.length) {
    const skip = heredocs.find((h) => i >= h.bodyStart && i < h.spanEnd);
    if (skip) { i = skip.spanEnd; continue; }
    const c = cmd[i]!;
    if (c === '\\') { i += 2; continue; }
    if (c === "'") { const e = cmd.indexOf("'", i + 1); if (e === -1) return -1; i = e + 1; continue; }
    if (c === '"') { const e = findDoubleQuoteEnd(cmd, i + 1, heredocs); if (e === -1) return -1; i = e + 1; continue; }
    if (c === '$' && cmd[i + 1] === '(') { depth++; i += 2; continue; }
    if (c === '(') { depth++; i++; continue; }
    if (c === ')') { depth--; if (depth === 0) return i; i++; continue; }
    i++;
  }
  return -1;
}

/** The literal text of a word with one layer of quoting removed. Never expands anything. */
export function unquote(raw: string): string {
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const c = raw[i]!;
    if (c === "'" || c === '"') {
      const close = raw.indexOf(c, i + 1);
      if (close === -1) { out += raw.slice(i + 1); break; }
      out += raw.slice(i + 1, close);
      i = close + 1;
      continue;
    }
    if (c === '\\' && i + 1 < raw.length) { out += raw[i + 1]; i += 2; continue; }
    out += c;
    i++;
  }
  return out;
}

/** The basename of a word's literal text, for asking what program it names. */
export function verbOf(word: Word): string {
  return unquote(word.raw).split('/').pop() ?? '';
}

/**
 * Every offset range in `cmd` that is INSIDE a quoted word.
 *
 * Used to answer "did this deny pattern match real shell, or text a command is carrying?".
 */
export function quotedRanges(l: Lex): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const w of l.words) {
    if (w.quoting === 'single' || w.quoting === 'double') out.push({ start: w.start, end: w.end });
  }
  return out;
}

/** The word that is the command name of the statement containing `offset`, if any. */
export function commandWordFor(l: Lex, offset: number): Word | undefined {
  let best: Word | undefined;
  for (const w of l.words) {
    if (w.start > offset) break;
    if (w.commandPosition) best = w;
  }
  return best;
}
