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
  /** Constituent questions that got no quotation. Empty when everything asked was answered. */
  unanswered?: string[];
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
    // A QUESTION WHOSE SUBJECT IS NOT IN THE CORPUS CANNOT BE ANSWERED FROM IT.
    //
    // "what is the roadmap for next quarter" has three content terms and the corpus knows exactly
    // one of them - `next`. Coverage is a fraction of the terms the corpus KNOWS, so the query
    // silently collapses to "next", matches any chunk containing it, and scores a perfect 1.00.
    // On the public tree that made the bot answer a roadmap question out of the README's defaults
    // section. Inventing a roadmap is the single worst thing this bot could do, and it got there
    // by scoring well.
    //
    // Whole-question retrieval hid this: the full sentence carried "windows" and "support" too, so
    // the ratio looked healthy. Decomposition is what exposed it, which is the point of it.
    //
    // Narrow on purpose. It only fires when a query has enough terms to judge (3+) AND almost
    // none of them are known (<2). "is it free" and "how do I install" have ONE content term each,
    // both known, and are untouched - the short-question floor has already been wrong twice in
    // this file and this rule is written not to be the third.
    const qTerms = tokenize(q);
    if (qTerms.length >= 3 && corpus.knownTerms(q) < 2) return [];

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
  // DECOMPOSE FIRST. `decomposeQuestions` splits into constituent QUESTIONS, not sentences -
  // "how do I install and use and monitor the impact" is three questions behind one head, and
  // treating it as one sub-query is how two of the three went unanswered on issue #14 (D-165).
  // `splitQueries` is kept alongside it so a sentence that does not decompose is still its own
  // query; the union is deduplicated below.
  // TWO TIERS, and the distinction is the whole fix.
  //
  // PRIMARY are the constituent questions the person actually asked. Each gets its own slot
  // before any of them gets a second - that is what "never let one question crowd out another"
  // means, and it only works if the primary list contains each question ONCE.
  //
  // The previous version concatenated decomposed questions, sentence splits, the focus string
  // and the whole body into one flat list and round-robined over that. "Is this free or paid?"
  // then appeared as three separate sub-queries - as a decomposition, as a sentence split, and
  // inside the whole-body query - so it took three rank-0 slots on its own and install and
  // monitoring got none. Round-robin over a list with duplicates is not round-robin (D-165).
  //
  // SUPPORTING queries only ever top up leftover slots.
  const primary = [...new Set(decomposeQuestions(question))];
  const supporting = [...new Set([
    ...(focus && focus.trim() ? [focus] : []),
    ...splitQueries(question),
    question,
  ])].filter((q) => !primary.includes(q));
  const queries = [...primary, ...supporting];

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
  //
  // Rank 0 runs over the PRIMARY questions only: one passage each, strongest question first, so a
  // four-question issue cannot spend three slots on the question the retriever liked most. Rank 1
  // and 2 then allow a second and third passage per question, and supporting queries join from
  // rank 1 - they are there to enrich an answer, never to displace one.
  // Which primary question does each chunk answer? Recorded as the slots are filled, so a
  // question that ends up with nothing can be declined BY NAME instead of silently dropped.
  const answersQuestion = new Map<string, string>();   // chunk key -> the question it answers
  const primaryOf = new Map<number, string>();
  primary.forEach((q, i) => primaryOf.set(i, q));

  const primaryHits = bySubQuery.slice(0, primary.length).filter((h) => h.length > 0)
    .sort((a, b) => (b[0]?.score ?? 0) - (a[0]?.score ?? 0));
  const allHits = bySubQuery.filter((h) => h.length > 0)
    .sort((a, b) => (b[0]?.score ?? 0) - (a[0]?.score ?? 0));
  for (let rank = 0; chosen.length < limit && rank < 3; rank++) {
    for (const hitsForQ of (rank === 0 ? primaryHits : allHits)) {
      const hit = hitsForQ[rank];
      if (!hit || chosen.length >= limit) continue;
      const k = keyOf(hit);
      if (taken.has(k)) continue;
      taken.add(k);
      if (rank === 0) {
        const qi = bySubQuery.indexOf(hitsForQ);
        const q = primaryOf.get(qi);
        if (q !== undefined && !answersQuestion.has(k)) answersQuestion.set(k, q);
      }
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
      unanswered: primary,
      body: (() => {
        const lines = [
          "**I could not find an answer to this in the repository's own documents, so I am not "
          + 'going to guess at one.** I only quote from files in this repo; I do not answer from '
          + 'general knowledge, because a confident wrong answer here would be worse than no '
          + 'answer.',
        ];
        // Never a bare dead end. Even when nothing clears the gates, the closest document is
        // still the most useful thing this bot knows, and saying so costs nothing.
        const nearest = corpus.search(question, 6, asks)
          .find((h) => !MAINTAINER_DOCS.has(h.chunk.file));
        if (nearest) {
          lines.push('');
          lines.push('The nearest document I have is '
            + `[\`${nearest.chunk.file}\`](${sourceUrl(nearest.chunk)}), under `
            + `*${nearest.chunk.heading}*. It may not be what you asked for — it is simply the `
            + 'closest thing in the documents I searched.');
        }
        lines.push('');
        lines.push('Flagged for a maintainer to read properly.');
        return lines.join('\n');
      })(),
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

  // ------------------------------------------------------------------------------------------
  // DECLINE EACH UNANSWERED QUESTION INDIVIDUALLY, AND POINT SOMEWHERE.
  //
  // A multi-question issue used to have exactly two outcomes: some quotations, or one blanket
  // "I could not find an answer". Neither says which of the four things asked went unanswered, so
  // a reader who got two good quotations had no way to know the other two were dropped - and the
  // maintainer had no way to know either.
  //
  // A decline also has to be USEFUL. "I could not find this" hands the reader nothing; it is a
  // dead end wearing an apology. So each unanswered question names the closest document the
  // retriever saw - the best hit BEFORE the relevance gates, which is by definition the most
  // related thing in the corpus - with a link and its heading, so there is always somewhere to go.
  //
  // This is deliberately NOT a generated summary of that document. The heading is copied verbatim.
  // See `assertNoGeneratedProse`: the bot quotes, cites, or declines, and never writes prose about
  // the product, because nobody can check its technical claims.
  // The nearest document must respect the same exclusion the ANSWER does. The first version
  // pointed a beginner at DECISIONS.md - the maintainer's log of things that went wrong, which is
  // the single most attractive chunk for any query the bot cannot answer, because it contains a
  // restatement of every question this bot has ever failed on (D-128). Sending a confused reader
  // there is worse than sending them nowhere.
  const nearestFor = (q: string): ReturnType<Corpus['search']>[number] | undefined =>
    corpus.search(q, 6, asks).find((h) => !MAINTAINER_DOCS.has(h.chunk.file));

  const answeredQs = new Set([...answersQuestion.entries()]
    .filter(([k]) => hits.some((h) => keyOf(h) === k)).map(([, q]) => q));
  const unanswered = primary.filter((q) => !answeredQs.has(q));
  const partial: string[] = [];
  if (unanswered.length > 0 && primary.length > 1) {
    partial.push('');
    partial.push('**I could not answer these from the documents, so I am not going to guess:**');
    partial.push('');
    // NOTHING FROM THE ISSUE IS EVER ECHOED. This listed each unanswered question by quoting it,
    // which read beautifully and is an injection vector: the adversarial set immediately caught it
    // reproducing a `<script>` tag into a rendered comment, echoing an injected instruction, and
    // tripping the bot's OWN forbidden-phrase guard with attacker-supplied text ("in the next
    // release"), which made it throw. The issue body is untrusted input and quoting it back is
    // the one thing this bot must never do - a rule it already held structurally until this line.
    //
    // Ordinal reference instead. The reader can count their own questions; the bot repeats none
    // of them. Strictly less pleasant to read, and the only version that is safe.
    const ordinal = (n: number): string =>
      ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'][n] ?? `${n + 1}th`;
    for (const q of unanswered) {
      const at = primary.indexOf(q);
      const which = primary.length > 1 && at >= 0
        ? `the ${ordinal(at)} thing you asked` : 'one of the things you asked';
      const nearest = nearestFor(q);
      if (nearest) {
        partial.push(`- **${which}** — nothing matched closely enough. The nearest document is `
          + `[\`${nearest.chunk.file}\`](${sourceUrl(nearest.chunk)}), under `
          + `*${nearest.chunk.heading}*.`);
      } else {
        partial.push(`- **${which}** — nothing in the documents matched it at all.`);
      }
    }
  }

  return {
    answered: true,
    topScore,
    citations: hits.map((h) => h.chunk.file),
    unanswered,
    body: [...out, ...partial].join('\n').trimEnd(),
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

/**
 * DECOMPOSE INTO CONSTITUENT QUESTIONS, not sentences.
 *
 * `splitQueries` splits on sentence boundaries, which is not the same thing and issue #14 is the
 * proof: "Is this free or paid? Also how do I install and use and monitor the impact of this?"
 * is two SENTENCES and four QUESTIONS. The second sentence bundles install, use and monitoring
 * behind one interrogative head, so all three competed for a single sub-query's slots and two of
 * them lost. The reader was told the documentation did not cover things the README covers.
 *
 * The split is deterministic and deliberately dumb — no model, no embeddings (see
 * `assertNoGeneratedProse`). A question is a sentence; a sentence with coordinated verb phrases
 * behind one interrogative head is several. "how do I install and use and monitor the impact"
 * becomes "how do I install", "how do I use", "how do I monitor the impact", each carrying the
 * head so the retriever still knows it is a how-question.
 *
 * What it deliberately does NOT do: split on "and" inside a noun phrase ("stars and forks"),
 * because the fragments would be shorter than the floor and are dropped. Over-splitting costs a
 * wasted slot; under-splitting costs an unanswered question, and only one of those reaches a user
 * as "the docs do not cover this".
 */
const INTERROGATIVE_HEAD =
  /^(?:also[,\s]+)?((?:how|what|why|when|where|which|who|does|do|did|can|could|is|are|will|would|should|shall)\b(?:\s+(?:do|does|did|can|could|i|you|we|it|this|that|the|there))*)\s+/i;

export function decomposeQuestions(text: string): string[] {
  const sentences = text
    .split(/(?<=[.?!])\s+|\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const out: string[] = [];
  for (const sentence of sentences) {
    const m = INTERROGATIVE_HEAD.exec(sentence);
    if (!m) {
      // Not an interrogative — keep it whole. A statement of the problem is one query.
      //
      // MEASURED AND REJECTED: a filter that admitted a non-interrogative sentence only when it
      // carried a hedge ("cannot tell whether", "not sure", "wondering"). The reasoning was sound
      // - a primary question earns a retrieval slot, and "putting this here in case it is useful
      // feedback on the docs" does not deserve one - and the numbers disagreed: adversarial went
      // 22/23 to 21/23, trading one failure for two different ones. It is recorded here rather
      // than shipped as a knob set to zero, which is what this repository did with the
      // IDF-weighted evidence floor for the same reason.
      out.push(sentence);
      continue;
    }
    const head = (m[1] ?? '').trim();
    const rest = sentence.slice(m[0].length);

    // Coordinators that join VERB phrases behind a shared head. `;` and `, and ` are included;
    // a bare comma is not, because "install, use and monitor" is one list and splitting on every
    // comma shreds ordinary prose.
    const clauses = rest
      .split(/\s+and\s+|\s*;\s*|\s*,\s+and\s+|\s+also\s+|\s*\/\s*/i)
      .map((c) => c.trim().replace(/[?.!]+$/, ''))
      .filter((c) => c.length > 0);

    if (clauses.length <= 1) {
      out.push(sentence);
      continue;
    }
    for (const c of clauses) {
      // DO NOT re-attach the head to a clause that already has an interrogative of its own.
      //
      // "When will you add Windows support and what is the roadmap for next quarter" splits into
      // "will you add Windows support" and "what is the roadmap for next quarter". The second one
      // is already a complete question, and prepending the head produced the ungrammatical
      // "When what is the roadmap for next quarter" - which then scored 4.35 at coverage 1.00
      // against an unrelated README section and made the bot ANSWER a roadmap question it is
      // supposed to decline. Garbage in the query is not neutral; it retrieves garbage
      // confidently, and a roadmap answer invented from the README is exactly the promise this
      // bot must never make.
      if (INTERROGATIVE_HEAD.test(c)) {
        if (tokenize(c).length >= 1) out.push(c);
        continue;
      }
      // Re-attach the head so each fragment is still a question the retriever can score.
      const q = `${head} ${c}`.trim();
      // FLOOR ON CONTENT TOKENS >= 1, NOT >= 3, and this is the second time that number has been
      // wrong in this file. `tokenize` strips stopwords, so "how do I install" has ONE content
      // token and "Is this free or paid?" has two - a floor of 3 discards every short question by
      // construction, which is precisely the defect fixed once already for the evidence floor.
      // A decomposed fragment has already earned its place by being a clause behind an
      // interrogative head; it does not have to also be long.
      if (tokenize(q).length >= 1) out.push(q);
    }
  }
  return [...new Set(out.filter((p) => tokenize(p).length >= 1))].slice(0, 12);
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
