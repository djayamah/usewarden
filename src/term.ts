/**
 * Terminal output. Spec section 3B: terminal-first, colour used semantically only, degrades
 * cleanly under NO_COLOR and when stdout is not a TTY, and every command supports --json.
 */

export function colorEnabled(stream: NodeJS.WriteStream = process.stdout): boolean {
  if (process.env['NO_COLOR'] !== undefined && process.env['NO_COLOR'] !== '') return false;
  if (process.env['FORCE_COLOR'] === '1') return true;
  return Boolean(stream.isTTY);
}

const CODES = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  cyan: '\u001b[36m',
  gray: '\u001b[90m',
} as const;

export type Colour = keyof typeof CODES;

export function paint(s: string, ...styles: Colour[]): string {
  if (!colorEnabled()) return s;
  return styles.map((c) => CODES[c]).join('') + s + CODES.reset;
}

/** Semantic helpers. Colour is never the only signal - the word is always there too. */
export const ok = (s: string) => paint(s, 'green');
export const bad = (s: string) => paint(s, 'red', 'bold');
export const warn = (s: string) => paint(s, 'yellow');
export const dim = (s: string) => paint(s, 'gray');
export const head = (s: string) => paint(s, 'bold');

export function stateBadge(state: string): string {
  switch (state) {
    case 'PROTECTED': return ok('PROTECTED');
    case 'UNPROTECTED': return bad('UNPROTECTED');
    case 'TAMPERED': return bad('TAMPERED');
    case 'POLICY_INVALID': return bad('POLICY_INVALID');
    default: return state;
  }
}

/**
 * The incident card is the product's screenshot (spec 3.6), so a long command must WRAP inside
 * the frame rather than blow the right-hand border out past the terminal. Continuation lines are
 * indented under the label so the card still scans as a table.
 */
export function box(title: string, lines: string[], maxWidth = 84): string {
  const width = Math.min(maxWidth, Math.max(title.length + 4, ...lines.map((l) => stripAnsi(l).length + 4)));
  const inner = width - 4;
  const wrapped: string[] = [];
  for (const l of lines) wrapped.push(...wrapLine(l, inner));
  const bar = '─'.repeat(width - 2);
  const out = [`┌${bar}┐`, `│ ${head(title.slice(0, inner))}${' '.repeat(Math.max(0, inner - title.length))} │`, `├${bar}┤`];
  for (const l of wrapped) {
    const pad = Math.max(0, inner - stripAnsi(l).length);
    out.push(`│ ${l}${' '.repeat(pad)} │`);
  }
  out.push(`└${bar}┘`);
  return out.join('\n');
}

/**
 * Wraps on visible width, ignoring ANSI. Colour is only ever applied to a whole label here, so
 * a naive slice cannot split an escape sequence: everything past the label is plain text.
 */
export function wrapLine(line: string, width: number): string[] {
  if (stripAnsi(line).length <= width) return [line];
  // Preserve the leading label + spacing as the hanging indent - but ONLY for a two-column line.
  //
  // The incident card and the doctor table lay out `label` and `value` separated by RUNS of
  // spaces ("when     2026-...", "why      Usewarden: ..."), and a continuation there should line
  // up under the value. Ordinary prose separates words with ONE space, and indenting its
  // continuation under the second word produces "Telemetry is OFF. ... send it / <11 spaces> to."
  // - which reads as a rendering fault even once the words stopped being cut in half.
  //
  // Requiring two or more spaces is what separates a column from a sentence.
  const m = /^(\S+ {2,}|\u001b\[[0-9;]*m\S+\u001b\[0m {2,})/.exec(line);
  const indentWidth = m ? Math.min(stripAnsi(m[1]!).length, Math.floor(width / 3)) : 0;
  const indent = ' '.repeat(indentWidth);
  const out: string[] = [];
  let rest = line;
  let first = true;
  // THE LOOP AND THE PUSH MUST AGREE ON THE BUDGET.
  //
  // They did not. The condition was `> width` while every continuation line is emitted as
  // `indent + take`, so the LAST fragment - the one that leaves the loop rather than being split
  // by it - could be up to `indentWidth` characters wider than the box that contains it. The
  // result is a card whose bottom border is short, which is what a live incident capture showed:
  //
  //     |          first (`git add x`), or make a targeted edit that keeps what is there. |
  //
  // It goes wrong only for a final fragment between `width - indentWidth` and `width` long, which
  // is why it survived the wrapping work that fixed the mid-word splits. Found by reading a real
  // incident card, not by a test - the same way the split-words defect was found.
  const budget = (): number => (first ? width : width - indentWidth);
  while (stripAnsi(rest).length > budget()) {
    const [take, remainder] = splitVisibleAtWord(rest, budget());
    out.push(first ? take : indent + take);
    rest = remainder;
    first = false;
  }
  if (stripAnsi(rest).length > 0) out.push(first ? rest : indent + rest);
  return out;
}

/**
 * Splits after at most `n` visible characters, PREFERRING A WORD BOUNDARY.
 *
 * `splitVisible` cuts at exactly n and nothing backed off to a space, so every box in the CLI
 * broke words in half. The first screen a new user sees after `usewarden init` read
 *
 *     v1 ships no endpoint to send it t
 *     o.
 *
 * and `demo` - the command whose entire job is to produce a screenshot-worthy incident card -
 * rendered "executes un / reviewed remote code" and "Pu / sh to a feature branch". It is
 * cosmetic and it is on the two screens this product is judged by.
 *
 * A long unbreakable token - an absolute path, a URL, a command line - must still hard-split, or
 * a single 200-character path would blow the box apart. So the backtrack is bounded: give up and
 * cut mid-token if the last space is in the first 40% of the budget.
 */
function splitVisibleAtWord(s: string, n: number): [string, string] {
  const [hard, hardRest] = splitVisible(s, n);
  if (hardRest.length === 0) return [hard, hardRest];
  // Already a clean break: the remainder begins at a space.
  if (/^\s/.test(hardRest)) return [hard.replace(/\s+$/, ''), hardRest.replace(/^\s+/, '')];

  let visible = 0;
  let lastSpaceIdx = -1;
  let lastSpaceVisible = 0;
  for (let i = 0; i < hard.length; i++) {
    if (hard[i] === '\u001b') { const e = hard.indexOf('m', i); if (e === -1) break; i = e; continue; }
    if (hard[i] === ' ') { lastSpaceIdx = i; lastSpaceVisible = visible; }
    visible++;
  }
  if (lastSpaceIdx < 0 || lastSpaceVisible < n * 0.4) return [hard, hardRest];
  return [s.slice(0, lastSpaceIdx).replace(/\s+$/, ''), s.slice(lastSpaceIdx + 1)];
}

/** Splits `s` after `n` VISIBLE characters, keeping ANSI sequences with the first half. */
function splitVisible(s: string, n: number): [string, string] {
  let visible = 0;
  let i = 0;
  while (i < s.length && visible < n) {
    if (s[i] === '\u001b') {
      const end = s.indexOf('m', i);
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    visible++; i++;
  }
  return [s.slice(0, i), s.slice(i)];
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

export function checkbox(done: boolean): string {
  return done ? ok('[x]') : dim('[ ]');
}

export function table(rows: string[][]): string {
  if (rows.length === 0) return '';
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => stripAnsi(r[i] ?? '').length)));
  return rows.map((r) => r.map((c, i) => c + ' '.repeat(Math.max(0, widths[i]! - stripAnsi(c).length))).join('  ').trimEnd()).join('\n');
}
