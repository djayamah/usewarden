import { Corpus, MAINTAINER_DOCS, MIN_COVERAGE, MIN_MATCHED_TERMS, MIN_SCORE, tokenize, type Chunk } from './corpus.js';

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
export function buildAnswer(
  corpus: Corpus, question: string, limit = 3, focus?: string, asksQuestion?: boolean,
): Answer {
  // BOTH gates. Score says the match is strong; coverage says it is about the same subject.
  // THREE gates. Score: the match is strong. Coverage: it is about the same subject. Matched
  // terms: there is enough evidence for either of those to mean anything.
  // The caller normally says whether this is a question, because beginner questions rarely carry
  // a `?`. When it does not - `buildAnswer` is called directly from tests and from the eval
  // harness - fall back to the same sniff `Corpus.score` uses, so every gate downstream sees ONE
  // answer to "is this a question". Reading the flag two different ways is how the maintainer-doc
  // rule below silently did not apply to the eval set.
  const asks = asksQuestion ?? question.includes('?');
  const pass = (q: string): ReturnType<Corpus['search']> => {
    // The floor cannot exceed what the question has to offer. See Corpus.knownTerms.
    const need = Math.min(MIN_MATCHED_TERMS, Math.max(1, corpus.knownTerms(q)));
    return corpus.search(q, limit + 1, asks).filter((h) =>
      h.score >= MIN_SCORE && h.coverage >= MIN_COVERAGE && h.matched >= need);
  };

  // PER SENTENCE, and this is the whole trick. Coverage is a fraction of the query's terms, so a
  // real issue defeats it: the first one this bot ever answered in public opened "hi. saw this on
  // github and it looks useful but im not sure i understand it properly" and closed with "sorry
  // if this is obvious, im not very technical" — genuine questions wrapped in politeness. Whole
  // body: coverage 0.19, declined. The sentence "does it need one of those api keys to work?":
  // coverage 0.40, answered. Eval questions are one clean sentence, so nothing caught this.
  //
  // A real issue usually asks more than one thing, and each question is its own good query. So
  // every sentence gets a turn, results are merged and deduplicated by chunk, and the best score
  // for a chunk across any sub-query is the one that counts.
  const queries = [
    ...(focus && focus.trim() ? [focus] : []),
    ...splitQueries(question),
    question,
  ];

  const best = new Map<string, ReturnType<Corpus['search']>[number]>();
  const bySubQuery: ReturnType<Corpus['search']>[] = [];
  for (const q of queries) {
    const hitsForQ = pass(q);
    bySubQuery.push(hitsForQ);
    for (const hit of hitsForQ) {
      const key = `${hit.chunk.file}#${hit.chunk.heading}`;
      const prev = best.get(key);
      if (!prev || hit.score > prev.score) best.set(key, hit);
    }
  }

  // ONE ANSWER PER QUESTION ASKED, before a second answer to any of them.
  //
  // Taking the global top-N undoes the point of splitting by sentence. Someone asked two things -
  // whether it needs an API key, and whether it uploads their project - and the README answers
  // both. Two strong passages about cost took both slots and the privacy half went unanswered:
  // the bot was most confident about the question it had already answered. So the slots are
  // filled round-robin, best hit from each sub-query first, and only then the next-best overall.
  // Within that, ordering is still by score, so a single-question issue is completely unaffected.
  const chosen: ReturnType<Corpus['search']> = [];
  const taken = new Set<string>();
  const keyOf = (h: ReturnType<Corpus['search']>[number]): string => `${h.chunk.file}#${h.chunk.heading}`;
  // Strongest sub-query first. Without this, round-robin hands a slot to "sorry for the long
  // message!" on equal terms with the sentence that actually asks something, and a polite closing
  // line displaces the answer - which is the original dilution defect wearing a different hat.
  const ranked = bySubQuery
    .filter((h) => h.length > 0)
    .sort((a, b) => (b[0]?.score ?? 0) - (a[0]?.score ?? 0));
  for (let rank = 0; chosen.length < limit && rank < 3; rank++) {
    for (const hitsForQ of ranked) {
      const hit = hitsForQ[rank];
      if (!hit || chosen.length >= limit) continue;
      const k = keyOf(hit);
      if (taken.has(k)) continue;
      taken.add(k);
      chosen.push(best.get(k) ?? hit);
    }
  }
  // Anything still short is topped up from the global ranking, so nothing is lost.
  for (const hit of [...best.values()].sort((a, b) => b.score - a.score)) {
    if (chosen.length >= limit) break;
    const k = keyOf(hit);
    if (taken.has(k)) continue;
    taken.add(k);
    chosen.push(hit);
  }
  let hits = chosen.sort((a, b) => b.score - a.score);
  const topScore = hits[0]?.score ?? 0;

  // ------------------------------------------------------------------------------------------
  // A MAINTAINER'S LOG MAY NEVER BE THE ONLY SOURCE OF AN ANSWER TO A QUESTION.
  //
  // DECISIONS.md is a log of things that went wrong, so it contains a restatement of every query
  // this bot has ever failed on. That makes it the single most attractive chunk for exactly the
  // queries the bot is supposed to DECLINE - the entry explaining why a question cannot be
  // answered is itself an excellent match for that question.
  //
  // This is the third appearance of the same shape. First a beginner's pricing question was
  // answered by quoting the decision entry about the bot mishandling pricing questions; the fix
  // was to down-weight maintainer docs for questions (D-128). Tonight, writing D-134 - an entry
  // about the bot wrongly answering an nginx question - made the bot answer that nginx question,
  // by quoting D-134. A 0.4 weight is not enough when the passage is literally about the query.
  //
  // Down-weighting is a preference and this is a rule: for a QUESTION, if every surviving passage
  // is from a maintainer document, there is no user-facing answer and the honest output is "I do
  // not know". For a BUG REPORT the log stays fully available - a decision entry is often the only
  // place a specific defect is explained, and that is the reader it was written for.
  //
  // It also means this project can write freely about its own retrieval defects without changing
  // the behaviour it is describing, which the previous design could not.
  // ------------------------------------------------------------------------------------------
  if (asks && hits.length > 0 && hits.every((h) => MAINTAINER_DOCS.has(h.chunk.file))) {
    hits = [];
  }

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
  // Horizontal rules are section furniture, not prose. Quoting one mid-answer looks like the bot
  // pasted the wrong thing, which is exactly how it reads to someone deciding whether to trust it.
  const text = chunk.text.replace(/^\s*---+\s*$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length <= maxChars) return text;

  let start = 0;
  if (query) {
    const terms = new Set(tokenize(query));
    const paras = splitParagraphs(text);
    // Score each paragraph, then take the window starting at the best one.
    // Term overlap, with a small bias toward the START of the section. Documents lead with their
    // main point, and a later paragraph that happens to share more words is usually a detail. The
    // Telemetry section opens with "off by default, no endpoint at all" and closes with a note
    // about purging counters; a pure overlap score picked the closing note for a reader asking
    // whether their code leaves the machine.
    let best = -1;
    let bestAt = 0;
    for (const [i, p] of paras.entries()) {
      const hits = [...new Set(tokenize(p.text))].filter((t) => terms.has(t)).length;
      const scored = hits - i * 0.35;
      if (hits > 0 && scored > best) { best = scored; bestAt = p.offset; }
    }
    if (best > -1) start = bestAt;
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

/**
 * Splits a question into sub-queries a retriever can actually use: sentences, and lines.
 * Fragments too short to carry meaning are dropped rather than allowed to match on one word.
 */
export function splitQueries(text: string): string[] {
  const parts = text
    .split(/(?<=[.?!])\s+|\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 12 && tokenize(p).length >= 3);
  return [...new Set(parts)].slice(0, 12);
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
/**
 * The bot's own sentences, with everything it merely REPRODUCED removed.
 *
 * Quoted lines are the reader seeing what a file says. Citation headers are the same thing one
 * level down: `**From [\`verification/live/12-dotenv-bypass-fixed.txt\`](…) — *heading*:**` is
 * entirely derived from the source - a path and a heading - and the bot chose none of the words
 * in it. The forbidden-phrase guard exists to stop the bot CLAIMING something is fixed, and it
 * refused to post a correct answer because a cited FILENAME contains the word. That is the
 * USING-versus-NAMING distinction (D-091) again, and getting it wrong here fails closed and
 * silently: the bot declines to comment at all, which looks like the bot being broken rather than
 * the guard being wrong.
 *
 * Only the header line is stripped, and only when it matches that exact shape, so a sentence the
 * bot actually wrote is still checked in full.
 */
export function botProseOnly(body: string): string {
  return body.split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .filter((l) => !/^\s*\*\*From \[`[^`]+`\]\(https?:\/\/[^)]+\)/.test(l))
    .join('\n');
}

export function assertAnswerIsSafe(body: string): void {
  const prose = botProseOnly(body);
  for (const re of FORBIDDEN_IN_ANSWER) {
    if (re.test(prose)) throw new Error(`answer refused: bot prose matches forbidden phrase ${re}`);
  }
}
