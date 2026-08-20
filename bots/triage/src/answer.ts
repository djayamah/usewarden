import { Corpus, MIN_COVERAGE, MIN_SCORE, tokenize, type Chunk } from './corpus.js';

/**
 * Builds an EXTRACTIVE answer: retrieved passages, quoted verbatim, with a file citation.
 *
 * The contract, all enforced here and asserted in tests:
 *   - every substantive answer cites the file it came from;
 *   - nothing that is not in the corpus reaches the reader;
 *   - below MIN_SCORE the bot says it does not know and flags a human. It never fills the gap;
 *   - no claim that anything is fixed, no timeline, no promise;
 *   - no metric that is not in the quoted passage, and no composite reported as its strongest
 *     component — docs/METRICS.md applies to the bot too, which is why the bot quotes rather
 *     than restates any figure.
 */

export interface Answer {
  /** True when the corpus had something relevant to quote. */
  answered: boolean;
  body: string;
  citations: string[];
  topScore: number;
}

/**
 * The question is untrusted text. It is used ONLY as a retrieval query, never as an instruction.
 *
 * `focus` is the issue TITLE when there is one. This matters more than it looks: coverage is a
 * fraction of the query's terms, so a realistic issue body — "just found this, before I install
 * it on my work laptop I want to know two things…" — dilutes it below the threshold and the bot
 * declines a question the README answers on its front page. The eval set missed this entirely
 * because its questions are short and clean; a real issue is neither. Retrieval now runs on the
 * title and on the whole text, and takes whichever finds more.
 */
export function buildAnswer(corpus: Corpus, question: string, limit = 2, focus?: string): Answer {
  // BOTH gates. Score says the match is strong; coverage says it is about the same subject.
  const pass = (q: string): ReturnType<Corpus['search']> =>
    corpus.search(q, limit).filter((h) => h.score >= MIN_SCORE && h.coverage >= MIN_COVERAGE);

  const fromFocus = focus && focus.trim() ? pass(focus) : [];
  const fromAll = pass(question);
  const hits = fromFocus.length >= fromAll.length ? fromFocus : fromAll;
  const topScore = hits[0]?.score ?? 0;

  if (hits.length === 0) {
    return {
      answered: false,
      topScore,
      citations: [],
      body: [
        "**I could not find an answer to this in the repository's own documents, so I am not going "
        + 'to guess at one.** I only quote from files in this repo; I do not answer from general '
        + 'knowledge, because a confident wrong answer here would be worse than no answer.',
        '',
        'Flagged for a maintainer to read properly.',
      ].join('\n'),
    };
  }

  const out: string[] = ['Here is what this repository says. I am quoting it directly rather than '
    + 'summarising, so you can check every word against the source:', ''];
  for (const { chunk } of hits) {
    out.push(`**From [\`${chunk.file}\`](${sourceUrl(chunk)}) — *${chunk.heading}*:**`);
    out.push('');
    out.push(quote(excerpt(chunk, 900, question)));
    out.push('');
  }

  return {
    answered: true,
    topScore,
    citations: hits.map((h) => h.chunk.file),
    body: out.join('\n').trimEnd(),
  };
}

const REPO_URL = 'https://github.com/djayamah/usewarden/blob/main';

function sourceUrl(chunk: Chunk): string {
  return `${REPO_URL}/${chunk.file}`;
}

/**
 * Keeps a quotation short enough to read while never editing the words inside it.
 *
 * QUERY-FOCUSED, and that turned out to matter. Taking the first N characters of a chunk looked
 * fine until the eval set asked "which agents does usewarden support" — retrieval correctly
 * picked the README's FAQ, and the excerpt then quoted the FAQ's FIRST entry, which is about
 * telemetry. Right file, right section, wrong paragraph, and an answer that reads as confidently
 * irrelevant. The window is now chosen by where the asker's own words actually appear.
 */
export function excerpt(chunk: Chunk, maxChars = 900, query?: string): string {
  const text = chunk.text.trim();
  if (text.length <= maxChars) return text;

  let start = 0;
  if (query) {
    const terms = new Set(tokenize(query));
    const paras = splitParagraphs(text);
    // Score each paragraph, then take the window starting at the best one.
    let best = -1;
    let bestAt = 0;
    for (const p of paras) {
      const hits = [...new Set(tokenize(p.text))].filter((t) => terms.has(t)).length;
      if (hits > best) { best = hits; bestAt = p.offset; }
    }
    if (best > 0) start = bestAt;
  }

  const cut = text.slice(start, start + maxChars);
  const lastBreak = Math.max(cut.lastIndexOf('\n\n'), cut.lastIndexOf('. '));
  const kept = lastBreak > maxChars * 0.4 ? cut.slice(0, lastBreak + 1) : cut;
  const prefix = start > 0 ? '[…] ' : '';
  const suffix = start + maxChars < text.length || start > 0
    ? '\n\n[…] (quotation truncated — the full text is in the linked file)' : '';
  return `${prefix}${kept.trim()}${suffix}`;
}

function splitParagraphs(text: string): { text: string; offset: number }[] {
  const out: { text: string; offset: number }[] = [];
  let offset = 0;
  for (const part of text.split(/\n\s*\n/)) {
    out.push({ text: part, offset });
    offset += part.length + 2;
  }
  return out;
}

function quote(s: string): string {
  return s.split('\n').map((l) => `> ${l}`).join('\n');
}

/**
 * Phrases the bot may never emit, whatever the corpus contains or a model suggests.
 * Checked over the final assembled comment.
 */
export const FORBIDDEN_IN_ANSWER: RegExp[] = [
  /\bthis (is|has been) fixed\b/i,
  /\bwe (have |'ve )?fixed\b/i,
  /\bwill be (fixed|released|shipped)\b/i,
  /\bin the next (release|version)\b/i,
  /\bby (next|this) (week|month)\b/i,
  /\bi (can|will) fix\b/i,
  /\bclosing this\b/i,
];

/**
 * Strips quoted lines before checking forbidden phrasing.
 *
 * This distinction is the whole point and it is the third time this repository has had to learn
 * it (D-091): a guard must tell USING a phrase apart from QUOTING it. `DECISIONS.md` is full of
 * the word "fixed" — that is what a decision log is — and the bot's most useful answers are
 * verbatim quotations from exactly those entries. A guard that fired on the quotation would
 * disable the bot precisely where it works best, and the obvious workaround (weaken the guard)
 * is the wrong one.
 *
 * A blockquote line is the reader seeing what a file says. Everything else is the bot talking.
 */
export function botProseOnly(body: string): string {
  return body.split('\n').filter((l) => !/^\s*>/.test(l)).join('\n');
}

export function assertAnswerIsSafe(body: string): void {
  const prose = botProseOnly(body);
  for (const re of FORBIDDEN_IN_ANSWER) {
    if (re.test(prose)) throw new Error(`answer refused: bot prose matches forbidden phrase ${re}`);
  }
}
