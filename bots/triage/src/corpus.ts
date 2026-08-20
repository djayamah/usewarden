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
  'when', 'what', 'how', 'why', 'which', 'there', 'here', 'so', 'than', 'then', 'about']);

export function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g)?.filter((t) => !STOPWORDS.has(t) && t.length > 1) ?? [];
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

  /** BM25. k1 and b are the standard defaults; nothing here is tuned to a benchmark. */
  score(query: string, chunk: Chunk): number {
    const k1 = 1.5;
    const b = 0.75;
    const N = this.chunks.length;
    let s = 0;
    for (const term of new Set(tokenize(query))) {
      const f = chunk.tf.get(term);
      if (!f) continue;
      const n = this.df.get(term) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (chunk.length / this.avgLen))));
    }
    return s * sourceWeight(chunk.file);
  }

  /** Fraction of the query's distinctive terms that appear in the chunk at all. */
  coverage(query: string, chunk: Chunk): number {
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0) return 0;
    // Rare terms are what make a question specific, so coverage is measured over the terms that
    // actually exist somewhere in the corpus - a typo or a proper noun nobody wrote about should
    // not be able to drag coverage to zero on its own.
    const known = terms.filter((t) => (this.df.get(t) ?? 0) > 0);
    if (known.length === 0) return 0;
    return known.filter((t) => chunk.tf.has(t)).length / known.length;
  }

  search(query: string, limit = 3): { chunk: Chunk; score: number; coverage: number }[] {
    return this.chunks
      .map((chunk) => ({ chunk, score: this.score(query, chunk), coverage: this.coverage(query, chunk) }))
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

export function sourceWeight(file: string): number {
  if (file.startsWith(TRANSCRIPT_DIR)) return 0.7;   // evidence, rarely the answer to a question
  return SOURCE_WEIGHTS[file] ?? 1;
}
