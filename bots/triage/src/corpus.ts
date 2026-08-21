import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * RETRIEVAL OVER THIS REPOSITORY'S OWN DOCUMENTS.
 *
 * ============================================================================================
 * WHY THIS IS EXTRACTIVE AND NOT GENERATIVE
 * ============================================================================================
 * The founder cannot check this bot's technical claims. That single fact decides the design: a
 * confident wrong answer is worse than no answer, and it is worse in a way nobody will catch.
 *
 * So the bot does not write prose about usewarden. It RETRIEVES passages from the repository's
 * published documents and QUOTES THEM VERBATIM with a file citation. A model, when one is
 * configured at all, is only ever used to RANK candidate passages — never to write, summarise,
 * paraphrase or extend them. There is no code path in which model-generated prose about the
 * product reaches a public comment.
 *
 * That eliminates the hallucination class outright rather than mitigating it. The cost is that
 * answers read like quotations, because they are quotations. For a tool whose entire pitch is
 * "verify, don't trust", that is the right trade.
 *
 * Retrieval is BM25-ish over heading-delimited chunks: no dependencies, no embeddings, no
 * network, deterministic, and testable. If the best chunk does not clear `MIN_SCORE`, the bot
 * says it does not know and flags a human. It never fills the gap.
 */

export interface Chunk {
  /** Repo-relative path, cited to the reader verbatim. */
  file: string;
  /** The heading this chunk sits under, for a precise citation. */
  heading: string;
  text: string;
  /** Lowercased token counts, precomputed. */
  tf: Map<string, number>;
  length: number;
}

/**
 * The documents the bot may answer from. Published documents only — everything here ships in the
 * public repository, so the bot can never quote something the reader cannot go and read.
 *
 * Deliberately ABSENT: PROGRESS.md, CLAUDE.md, SPEC-BUILD.md and anything under .claude/ or ops/.
 * Those are the internal build record; some carry founder-facing notes and machine paths, and a
 * bot that quotes them into a public issue has published them.
 */
export const CORPUS_FILES = [
  'README.md',
  'docs/METRICS.md',
  'docs/HOOK-MATRIX.md',
  'docs/THREAT-MODEL.md',
  'docs/TELEMETRY.md',
  'docs/DEPENDENCY-BUDGET.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'DECISIONS.md',
  'FINAL-REPORT.md',
] as const;

/** Live session transcripts, added separately because they are evidence rather than prose. */
export const TRANSCRIPT_DIR = 'verification/live';

const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be',
  'been', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'as', 'it', 'its', 'this',
  'that', 'these', 'those', 'i', 'you', 'we', 'they', 'my', 'your', 'our', 'their', 'not', 'no',
  'do', 'does', 'did', 'can', 'could', 'will', 'would', 'should', 'has', 'have', 'had', 'if',
  'when', 'what', 'how', 'why', 'which', 'there', 'here', 'so', 'than', 'then', 'about',
  // ---------------------------------------------------------------------------------------
  // POLITENESS AND HEDGING. Added after the adversarial set, and this is the second time this
  // exact mechanism has cost the bot an answer.
  //
  // Coverage is the fraction of the query's KNOWN terms that a chunk contains, and a term counts
  // as known if it appears anywhere in ten documents totalling several hundred kilobytes — which
  // means "still", "want", "know" and "whether" all count. "i still want to know whether any of
  // my source code leaves the machine" is nine terms, four of which are the person being polite.
  // The README passage that answers it verbatim contains three of the five real ones and scores
  // 0.33 coverage against a 0.34 floor, so the bot declined a question its own front page
  // answers. Denominator inflation by filler is the same defect as the 150-word-preamble case
  // (D-128); splitting by sentence fixed it at the sentence level and not at the word level.
  //
  // Every word below is a word someone uses to ASK, never a word this project's documents use to
  // ANSWER. Content words are deliberately absent: `need`, `cost`, `key`, `block`, `machine` and
  // `time` all stay, even where they read as filler in one phrasing, because they carry the
  // question in another.
  // ---------------------------------------------------------------------------------------
  'i', 'im', "i'm", 'ive', "i've", 'id', 'me', 'us', 'him', 'her', 'them', 'myself', 'am',
  'just', 'still', 'really', 'actually', 'basically', 'simply', 'maybe', 'perhaps', 'probably',
  'please', 'thanks', 'thank', 'sorry', 'apologies', 'hi', 'hello', 'hey', 'dear', 'sir', 'madam',
  'want', 'wanting', 'wanted', 'know', 'knowing', 'whether', 'wondering', 'wonder', 'curious',
  'any', 'anything', 'something', 'anyone', 'someone', 'everything', 'nothing',
  'also', 'like', 'quick', 'quickly', 'bit', 'lot', 'lots', 'very', 'quite', 'pretty', 'little',
  'question', 'questions', 'ask', 'asking', 'asked', 'answer', 'answered', 'reply',
  'much', 'many', 'sure', 'think', 'thought', 'feel', 'feels', 'seems', 'seem', 'looks',
  'thing', 'things', 'stuff', 'good', 'great', 'nice', 'morning', 'afternoon', 'evening',
  'get', 'getting', 'got', 'go', 'going', 'goes', 'put', 'take', 'taking', 'give', 'giving']);

/**
 * TRAILING PUNCTUATION IS NOT PART OF A WORD, AND FOR MONTHS IT WAS.
 *
 * The character class allows `.`, `_` and `-` INSIDE a token on purpose: `usewarden.yaml`,
 * `node:sqlite`, `package.json`, `--json` and `22.13` all have to survive tokenisation, and a
 * tokeniser that splits them retrieves nothing for someone asking about a config file by name.
 *
 * But it allowed them at the END too, so every sentence-final word became a DIFFERENT TERM from
 * the same word used mid-sentence. `machine.` and `machine` were unrelated tokens. Measured over
 * this corpus: 732 of 5,736 vocabulary entries — 12.8% — were punctuation shadows of a term that
 * already existed, and 7.0% of all term-chunk pairs carried one.
 *
 * It is invisible because it degrades gracefully. Nothing errors, no test fails, and retrieval
 * keeps working on every query whose keyword happens to appear mid-sentence somewhere. It only
 * shows up as answers that are slightly worse than they should be, and as coverage scores that
 * sit just under the floor — which is exactly how it was found: the README passage that answers
 * "does my code leave the machine" scored 15.25 and was DECLINED at 0.222 coverage, because
 * `machine` was not in its index under that name.
 *
 * Internal punctuation is kept; trailing punctuation is trimmed.
 */
export function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g)
    ?.map((t) => t.replace(/[._-]+$/, ''))
    .filter((t) => !STOPWORDS.has(t) && t.length > 1) ?? [];
}

/**
 * ============================================================================================
 * QUERY EXPANSION: THE WORDS SOMEONE ASKS IN ARE NOT THE WORDS A DOCUMENT ANSWERS IN.
 * ============================================================================================
 * BM25 matches surface forms. It has no idea that "computer" and "machine" are the same thing,
 * and this corpus consistently says `machine`, `telemetry`, `latency` and `cost` while the people
 * opening issues consistently say `computer`, `uploaded to a server`, `delay` and `pay`. The
 * result is a bot that answers fluently when you already speak its documentation and declines
 * when you do not — which inverts who the support bot is FOR.
 *
 * Measured on the adversarial set: "our source codes they are uploaded to some server or they
 * stay in the computer only" retrieved nothing at all, while the README passage that answers it
 * exactly ("never leaves your machine") sat unmatched, because the two sentences share no content
 * word. That is not a threshold problem and no amount of tuning MIN_COVERAGE reaches it.
 *
 * THE RULES THIS FOLLOWS, AND WHY EACH ONE IS THERE
 *
 *   1. Expansion applies to the QUERY ONLY. The index is never rewritten, so a citation always
 *      points at a passage that literally contains the words it is quoted for, and the reader can
 *      check it. Expanding the index would let the bot quote a passage as an answer to a word
 *      that does not appear in it.
 *
 *   2. A synonym match is DISCOUNTED (`SYNONYM_WEIGHT`). "machine" answering "computer" is real
 *      evidence but weaker than "machine" answering "machine", and a literal match must always
 *      outrank a substituted one when both are available.
 *
 *   3. Groups are hand-written and each one is checked against the corpus, not generated. A
 *      general-purpose thesaurus is exactly how "configure a reverse proxy" started scoring
 *      against SECURITY.md (see MIN_COVERAGE). Every group below exists because a specific real
 *      phrasing failed on it.
 *
 *   4. The floors are unchanged. Expansion changes what COUNTS as a match; it does not lower the
 *      bar a match has to clear. If this makes the bot answer something it should decline, the
 *      eval sets say so — which is the only reason to trust it.
 */
export const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  // "does it stay on my computer" / "never leaves your machine"
  ['machine', 'machines', 'laptop', 'laptops', 'computer', 'computers', 'desktop', 'device', 'pc'],
  // "does it upload my project" / "the only thing that can ever leave"
  ['upload', 'uploads', 'uploaded', 'uploading', 'send', 'sends', 'sent', 'sending', 'transmit',
    'transmitted', 'leave', 'leaves', 'leaving', 'left', 'exfiltrate', 'exfiltration'],
  // "to some server" / "no endpoint at all"
  // NOT `telemetry`, `network` or `wire`. Telemetry is a CONCEPT this project has a whole
  // document about, not another word for a server, and folding it in gave the generic noun
  // "server" the reach of the corpus's most distinctive term - enough to answer "i am setting up
  // a new server and cannot work out the right configuration" from docs/TELEMETRY.md. The link
  // that actually carries the privacy question is server -> endpoint, and that one is exact.
  ['server', 'servers', 'cloud', 'endpoint', 'endpoints', 'internet', 'remote', 'online'],
  // "my source codes" / "does this send my code anywhere"
  ['code', 'codes', 'source', 'sources', 'codebase', 'project', 'projects', 'repo', 'repos',
    'repository', 'repositories'],
  // "is it free" / "what does it cost to run" / "a paid tier"
  ['free', 'cost', 'costs', 'price', 'prices', 'pricing', 'pay', 'paid', 'paying', 'money',
    'charge', 'charged', 'charges', 'billing', 'bill', 'subscription', 'fee', 'fees', 'tier',
    'expensive', 'cheap'],
  // "one of those api keys"
  // NOT `token`/`tokens`. In THIS corpus a token is overwhelmingly an LLM token — "zero tokens,
  // every event", "tokens and money saved" — and only occasionally a credential. Grouping the two
  // made "how do you calculate the tokens and money saved" retrieve the README's *Do I need an
  // API key?* entry three times over docs/METRICS.md, which is the document that answers it. A
  // synonym group is a claim that two words mean the same thing HERE, not in general.
  ['key', 'keys', 'apikey', 'api_key', 'credential', 'credentials'],
  // "does it slow my agent down" / "a noticeable delay" / the docs say latency and overhead
  ['slow', 'slows', 'slower', 'slowdown', 'delay', 'delays', 'delayed', 'lag', 'latency',
    'overhead', 'performance', 'speed', 'fast', 'faster'],
  // "it stopped a command" / "blocked" / "denied"
  ['block', 'blocks', 'blocked', 'blocking', 'stop', 'stops', 'stopped', 'stopping', 'prevent',
    'prevents', 'prevented', 'deny', 'denies', 'denied', 'refuse', 'refuses', 'refused',
    'reject', 'rejects', 'rejected'],
  // "how do i get rid of it"
  ['uninstall', 'uninstalls', 'uninstalled', 'uninstalling', 'remove', 'removes', 'removed',
    'removing', 'delete', 'deletes', 'deleting'],
  // "a bit worried about privacy"
  ['privacy', 'private', 'confidential', 'confidentiality', 'secret', 'secrets'],
  // "i ran the setup thing"
  ['install', 'installs', 'installed', 'installing', 'installation', 'setup', 'init'],
  // ------------------------------------------------------------------------------------------
  // DELETED: a `config / configure / configuration / settings` group.
  //
  // It was written for "is there a config file somewhere" and it broke the one case in the eval
  // set that exists to prove the bot declines: "what is the best way to configure nginx as a
  // reverse proxy for Rails" went from a correct decline to an ANSWER out of SECURITY.md,
  // because `configure` reached `configuration` and lifted coverage from 0.20 to 0.40 across a
  // 0.34 floor. `configure` is a generic English verb; every other group here is built from
  // words that are specific to what someone is asking ABOUT. Trimming the group was not enough —
  // the whole group was the defect, and the case it was written for retrieves fine without it.
  //
  // Kept as a comment rather than deleted silently, because the next person to notice that
  // "config" is missing from this list should find out that it was tried.
  // ------------------------------------------------------------------------------------------
];

/** How much a substituted match is worth relative to a literal one. Never 1: literal must win. */
export const SYNONYM_WEIGHT = 0.75;

const GROUP_OF = new Map<string, number>();
for (const [gi, group] of SYNONYM_GROUPS.entries()) {
  for (const t of group) GROUP_OF.set(t, gi);
}

/**
 * One unit per DISTINCT IDEA in the query, rather than one per distinct word.
 *
 * Deduplicating by group also fixes a quieter double-count: "does it cost money to pay for"
 * previously contributed three separate terms from one idea, inflating both score and the
 * coverage denominator for a question that asked one thing.
 */
export interface QueryUnit { primary: string; forms: string[] }

export function queryUnits(query: string): QueryUnit[] {
  const out: QueryUnit[] = [];
  const seenGroup = new Set<number>();
  const seenTerm = new Set<string>();
  for (const t of tokenize(query)) {
    const g = GROUP_OF.get(t);
    if (g === undefined) {
      if (seenTerm.has(t)) continue;
      seenTerm.add(t);
      out.push({ primary: t, forms: [t] });
    } else {
      if (seenGroup.has(g)) continue;
      seenGroup.add(g);
      out.push({ primary: t, forms: [t, ...SYNONYM_GROUPS[g]!.filter((f) => f !== t)] });
    }
  }
  return out;
}

function countTokens(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/** Splits a markdown document on headings, keeping each heading with its body. */
export function chunkMarkdown(file: string, body: string): Chunk[] {
  const lines = body.split('\n');
  const chunks: Chunk[] = [];
  let heading = '(top)';
  let buf: string[] = [];

  const flush = (): void => {
    const text = buf.join('\n').trim();
    if (text.length >= 80) {
      const tokens = tokenize(`${heading} ${text}`);
      chunks.push({ file, heading, text, tf: countTokens(tokens), length: tokens.length });
    }
    buf = [];
  };

  for (const line of lines) {
    const m = /^(#{1,4})\s+(.*)$/.exec(line);
    if (m) { flush(); heading = m[2]!.trim(); continue; }

    // A line that is entirely bold is a FAQ question. Splitting on it matters: the README's FAQ
    // was a single chunk holding every Q&A, and BM25's length penalty meant a short precise
    // answer inside it lost to a loosely-related code block elsewhere. Each question is now its
    // own chunk, which is also what makes the citation point somewhere a reader can find.
    const q = /^\*\*(.+?)\*\*$/.exec(line.trim());
    if (q && buf.length > 0) { flush(); heading = q[1]!.trim(); buf.push(line); continue; }
    if (q) { heading = q[1]!.trim(); }

    buf.push(line);
    // Very long sections are split so a citation points at something a reader can find.
    if (buf.length > 45) { flush(); }
  }
  flush();
  return chunks;
}

export class Corpus {
  readonly chunks: Chunk[] = [];
  private readonly df = new Map<string, number>();
  private avgLen = 0;

  constructor(repoRoot: string, files: readonly string[] = CORPUS_FILES, includeTranscripts = true) {
    for (const f of files) {
      let body: string;
      try { body = fs.readFileSync(path.join(repoRoot, f), 'utf8'); } catch { continue; }
      this.chunks.push(...chunkMarkdown(f, body));
    }
    if (includeTranscripts) {
      const dir = path.join(repoRoot, TRANSCRIPT_DIR);
      let entries: string[] = [];
      try { entries = fs.readdirSync(dir).filter((e) => e.endsWith('.txt')); } catch { /* none */ }
      for (const e of entries.sort()) {
        const body = fs.readFileSync(path.join(dir, e), 'utf8');
        // A transcript is one chunk: quoting half of one is worse than not quoting it.
        const text = body.slice(0, 4000);
        const tokens = tokenize(text);
        this.chunks.push({
          file: `${TRANSCRIPT_DIR}/${e}`, heading: 'live agent session transcript',
          text, tf: countTokens(tokens), length: tokens.length,
        });
      }
    }

    for (const c of this.chunks) {
      for (const t of c.tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    this.avgLen = this.chunks.reduce((n, c) => n + c.length, 0) / Math.max(1, this.chunks.length);
  }

  /**
   * BM25. k1 and b are the standard defaults; nothing here is tuned to a benchmark.
   *
   * `asksQuestion` used to be sniffed from the query as `query.includes('?')`. That works on an
   * eval set, where every question is one well-formed sentence ending in a question mark, and it
   * fails on the phrasing this bot actually receives: "does this slow my agent down", "do i have
   * to give it my code", and a 150-word issue whose only real clause is "so my question is
   * basically whether i need an api key to use this or not." - none of which contains a `?`.
   * When it was sniffed, those queries got no maintainer-doc down-weighting and no FAQ-heading
   * boost, so the bot answered a beginner's pricing question by quoting DECISIONS.md - the
   * maintainer's log of the bot's own previous failure. The caller knows the intent; it says so.
   */
  score(query: string, chunk: Chunk, asksQuestionArg?: boolean): number {
    const k1 = 1.5;
    const b = 0.75;
    const N = this.chunks.length;
    let s = 0;
    // One contribution per IDEA, taking the best surface form the chunk actually contains. A
    // substituted form is discounted so a literal match always outranks a synonym match.
    for (const unit of queryUnits(query)) {
      let best = 0;
      for (const form of unit.forms) {
        const f = chunk.tf.get(form);
        if (!f) continue;
        const n = this.df.get(form) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        const contrib = idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (chunk.length / this.avgLen))))
          * (form === unit.primary ? 1 : SYNONYM_WEIGHT);
        if (contrib > best) best = contrib;
      }
      s += best;
    }
    // A question-headed section answering a question is a strong signal that BM25 alone misses.
    // The README FAQ entry "Does this send my code anywhere?" is short, so length normalisation
    // pushed it below the long Telemetry section for a reader who asked exactly that - and the
    // bot led with a passage about counters. A heading that IS the question deserves the weight.
    const asksQuestion = asksQuestionArg ?? query.includes('?');
    const headingIsQuestion = chunk.heading.trim().endsWith('?');
    return s * sourceWeight(chunk.file, asksQuestion) * (asksQuestion && headingIsQuestion ? 1.6 : 1);
  }

  /** Fraction of the query's distinctive terms that appear in the chunk at all. */
  coverage(query: string, chunk: Chunk): number {
    const units = queryUnits(query);
    if (units.length === 0) return 0;
    // Rare terms are what make a question specific, so coverage is measured over the terms that
    // actually exist somewhere in the corpus - a typo or a proper noun nobody wrote about should
    // not be able to drag coverage to zero on its own.
    const known = units.filter((u) => u.forms.some((f) => (this.df.get(f) ?? 0) > 0));
    if (known.length === 0) return 0;
    return known.filter((u) => u.forms.some((f) => chunk.tf.has(f))).length / known.length;
  }

  /** How many of the query's distinctive terms actually appear in the chunk. */
  matchedTerms(query: string, chunk: Chunk): number {
    return queryUnits(query).filter((u) => u.forms.some((f) => chunk.tf.has(f))).length;
  }

  /**
   * How many of the query's terms exist anywhere in the corpus at all.
   *
   * The evidence floor asks for at least two matched terms. A three-word question - "is this
   * free", "does it cost" - has exactly one after stop words, so it could never clear a floor of
   * two no matter how good the match was, and the bot declined every short question by
   * construction. You cannot require more terms than the question contains; the floor is capped
   * at what is available, and coverage and score still have to clear on their own.
   */
  knownTerms(query: string): number {
    return queryUnits(query).filter((u) => u.forms.some((f) => (this.df.get(f) ?? 0) > 0)).length;
  }


  search(query: string, limit = 3, asksQuestion?: boolean):
  { chunk: Chunk; score: number; coverage: number; matched: number }[] {
    return this.chunks
      .map((chunk) => ({
        chunk, score: this.score(query, chunk, asksQuestion), coverage: this.coverage(query, chunk),
        matched: this.matchedTerms(query, chunk),
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

/**
 * Below this, the bot declines rather than answers.
 *
 * Chosen by running the eval set (`bots/triage/src/eval.ts`) and picking a value that admits the
 * questions the corpus genuinely answers while rejecting the ones it does not. It is deliberately
 * on the cautious side: a false decline costs the maintainer one reply, and a false answer costs
 * a reader their trust.
 */
export const MIN_SCORE = 3.5;

/**
 * How much of the asker's distinctive vocabulary a chunk must actually contain.
 *
 * BM25 alone was not enough, and the eval set is what showed it: "what is the best way to
 * configure nginx as a reverse proxy for my Rails app" scored 5.2 against SECURITY.md purely on
 * generic words — configure, best, way — and the bot answered a question about nginx by quoting
 * a security policy. Score measures how WELL terms match; it does not measure how MANY of them
 * do. Requiring coverage as well is what separates "related" from "shares some English".
 */
export const MIN_COVERAGE = 0.34;

/**
 * An absolute floor on EVIDENCE, alongside the coverage fraction.
 *
 * Splitting a question into sentences made retrieval much better on real issues and introduced
 * one new way to be wrong: a three-word sub-query that matches two words scores 0.67 coverage on
 * almost no evidence. "when will you ship windows and what is the roadmap" started being answered
 * from docs/METRICS.md on exactly that basis. A fraction says how much of the query matched; it
 * does not say how much matched. Both matter, so both are checked.
 *
 * Two, not three, and chosen by measurement rather than taste: at 3 the eval drops to 18/20
 * because a short honest question like "what version of Node does this require?" has only three
 * distinctive terms and would need all of them. At 2 the eval is 20/20, the real rambling issue
 * is answered, and the roadmap question is still correctly declined.
 */
export const MIN_MATCHED_TERMS = 2;


/**
 * Source weighting. DECISIONS.md and FINAL-REPORT.md are the internal record: they are enormous,
 * they contribute the majority of chunks, and they are written in this project's own jargon, so
 * BM25 hands them almost every query. They are also the WRONG answer for a support question -
 * someone asking "do I need an API key" should be shown the README, which was written for them,
 * not a decision entry written for a maintainer.
 *
 * They stay in the corpus because they are often the only place a specific defect is explained.
 * They are simply outranked when a user-facing document says the same thing.
 */
export const SOURCE_WEIGHTS: Record<string, number> = {
  'README.md': 1.35,
  'docs/METRICS.md': 1.2,
  'docs/HOOK-MATRIX.md': 1.2,
  'docs/TELEMETRY.md': 1.2,
  'docs/THREAT-MODEL.md': 1.2,
  'docs/DEPENDENCY-BUDGET.md': 1.2,
  'SECURITY.md': 1.15,
  'CONTRIBUTING.md': 1.1,
  'DECISIONS.md': 0.75,
  'FINAL-REPORT.md': 0.75,
};

/** Documents written for a MAINTAINER, not for someone asking a question. */
export const MAINTAINER_DOCS: ReadonlySet<string> = new Set(['DECISIONS.md', 'FINAL-REPORT.md']);

export function sourceWeight(file: string, asksQuestion = false): number {
  if (file.startsWith(TRANSCRIPT_DIR)) return 0.7;   // evidence, rarely the answer to a question
  // A decision log is a maintainer's record. It is term-rich and long, so BM25 loves it, and it
  // is almost never what someone asking "do i need to pay for something" should be shown. It led
  // the answer to exactly that question once. It stays in the corpus - it is often the only place
  // a specific defect is explained - but a question outranks it decisively.
  if (asksQuestion && MAINTAINER_DOCS.has(file)) return 0.4;
  return SOURCE_WEIGHTS[file] ?? 1;
}
