import { Corpus } from './corpus.js';
import { buildAnswer } from './answer.js';
import { triage, type Issue } from './triage.js';

/**
 * THE EVAL SET.
 *
 * Ten hard questions taken from `launch/HN-COMMENT-PREP.md` — the ones a skeptical reader asks
 * first — plus the obvious support questions anyone installing the tool will ask.
 *
 * Each case declares one of two expectations, and BOTH are passes:
 *
 *   `expectCites`  — the answer must quote the named file. A bot that answers correctly from the
 *                    wrong source is not passing; the citation is the product.
 *   `expectDecline` — the corpus genuinely does not answer this, and the bot must SAY SO rather
 *                    than reach for general knowledge. A decline here is the correct answer, and
 *                    scoring it as a failure would train the bot toward exactly the confident
 *                    guessing this design exists to prevent.
 *
 * The pass rate is reported honestly, including which cases fail and why.
 */

export interface EvalCase {
  id: string;
  question: string;
  /**
   * Repo-relative files, ANY of which is a correct citation.
   *
   * More than one document legitimately answers some of these, and the eval was wrong to insist
   * on a single canonical file. Every alternative listed here was checked by reading the passage
   * the bot actually quotes and confirming it answers the question — not by widening until the
   * number went green, which is the failure mode this project keeps writing tests against.
   */
  expectCites?: string[];
  /** True when the only correct behaviour is to decline. */
  expectDecline?: boolean;
  /** Where this question comes from, so the set can be audited. */
  origin: 'hn-hard' | 'support';
}

export const EVAL_SET: EvalCase[] = [
  // ---- the ten hardest, from launch/HN-COMMENT-PREP.md -------------------------------------
  { id: 'hn-allowlists', origin: 'hn-hard',
    question: 'Why not just use the permissions and allowlists built into the agent itself?',
    expectCites: ['README.md'] },
  { id: 'hn-just-hooks', origin: 'hn-hard',
    question: 'Is this just a wrapper around hooks?',
    // The README FAQ gained a direct answer BECAUSE this eval case failed — the eval found a
    // documentation gap, which is the eval working. Verified by reading the quoted passage.
    expectCites: ['docs/HOOK-MATRIX.md', 'README.md'] },
  { id: 'hn-catch-rate', origin: 'hn-hard',
    question: 'What is the layer 1 catch rate on the sabotage suite and is it self graded?',
    expectCites: ['README.md'] },
  { id: 'hn-llm-in-security', origin: 'hn-hard',
    question: 'Why should I trust a security tool that has an LLM in it? Can the judge block things?',
    expectCites: ['README.md'] },
  { id: 'hn-telemetry', origin: 'hn-hard',
    question: 'What telemetry does this collect and is there an endpoint?',
    expectCites: ['docs/TELEMETRY.md'] },
  { id: 'hn-sandbox', origin: 'hn-hard',
    question: 'Is this a sandbox? Can it contain a determined agent that lies about its tool input?',
    // README "What usewarden cannot catch" opens with "Usewarden is not a sandbox" — verified by
    // reading the quoted passage. That is a better answer for a reader than the threat model.
    expectCites: ['docs/THREAT-MODEL.md', 'README.md'] },
  { id: 'hn-config-write', origin: 'hn-hard',
    question: 'Why should I let this write into my .claude/settings.json? What if it breaks my config?',
    expectCites: ['docs/THREAT-MODEL.md'] },
  { id: 'hn-install-scripts', origin: 'hn-hard',
    question: 'Does this package have install scripts or runtime dependencies?',
    expectCites: ['docs/DEPENDENCY-BUDGET.md'] },
  { id: 'hn-savings-number', origin: 'hn-hard',
    question: 'How do you calculate the tokens and money saved? Is that a real measurement?',
    expectCites: ['docs/METRICS.md'] },
  { id: 'hn-demo-inflation', origin: 'hn-hard',
    question: 'Can running the demo inflate the actions blocked counter?',
    expectCites: ['docs/METRICS.md'] },

  // ---- obvious support questions -----------------------------------------------------------
  { id: 'sup-api-key', origin: 'support',
    question: 'Do I need an API key to use this?',
    expectCites: ['README.md'] },
  { id: 'sup-send-code', origin: 'support',
    question: 'Does usewarden send my code anywhere?',
    expectCites: ['README.md'] },
  { id: 'sup-agents', origin: 'support',
    question: 'Which agents does usewarden support and which are verified?',
    // The README FAQ has a "Which agents does it support?" entry naming the verified ones and
    // linking the matrix. Verified by reading it.
    expectCites: ['docs/HOOK-MATRIX.md', 'README.md'] },
  { id: 'sup-unprotected', origin: 'support',
    question: 'usewarden status says UNPROTECTED. What does that mean?',
    expectCites: ['README.md'] },
  { id: 'sup-uninstall', origin: 'support',
    question: 'How do I uninstall usewarden and get my agent config back?',
    expectCites: ['README.md'] },
  { id: 'sup-node-version', origin: 'support',
    question: 'What version of Node does this require?',
    expectCites: ['README.md'] },
  { id: 'sup-report-vuln', origin: 'support',
    question: 'How do I report a security vulnerability?',
    expectCites: ['SECURITY.md'] },
  { id: 'sup-judge-cost', origin: 'support',
    question: 'How much does the layer 2 judge cost to run and which provider does it pick?',
    expectCites: ['README.md'] },

  // ---- questions the corpus does NOT answer. Declining is the pass. -------------------------
  { id: 'decline-roadmap', origin: 'support',
    question: 'When will you add Windows support and what is the roadmap for next quarter?',
    expectDecline: true },
  { id: 'decline-unrelated', origin: 'support',
    question: 'What is the best way to configure nginx as a reverse proxy for my Rails app?',
    expectDecline: true },
];

export interface EvalResult {
  id: string;
  origin: string;
  passed: boolean;
  detail: string;
}

export function runEval(corpus: Corpus, cases: EvalCase[] = EVAL_SET): EvalResult[] {
  return cases.map((c) => {
    const a = buildAnswer(corpus, c.question);
    if (c.expectDecline) {
      return {
        id: c.id, origin: c.origin, passed: !a.answered,
        detail: a.answered
          ? `answered when it should have declined (score ${a.topScore.toFixed(2)}, cited ${a.citations.join(', ')})`
          : 'correctly declined',
      };
    }
    const cited = a.answered && c.expectCites!.some((f) => a.citations.includes(f));
    return {
      id: c.id, origin: c.origin, passed: cited,
      detail: !a.answered
        ? `declined; expected a quotation from ${c.expectCites!.join(' | ')} (best score ${a.topScore.toFixed(2)})`
        : cited ? `cited ${a.citations[0]}` : `cited ${a.citations.join(', ')}, expected one of ${c.expectCites!.join(' | ')}`,
    };
  });
}

/** The issue-shaped end-to-end check: an eval question arriving as a real GitHub issue. */
export function asIssue(c: EvalCase, n = 1): Issue {
  return { number: n, title: c.question, body: c.question, user: 'someone' };
}

export function runEndToEnd(corpus: Corpus, cases: EvalCase[] = EVAL_SET): EvalResult[] {
  return cases.map((c, i) => {
    const r = triage(asIssue(c, i + 1), corpus);
    const identifies = r.comment.includes('Automated triage');
    const declined = r.answer !== undefined && !r.answer.answered;
    const passed = c.expectDecline
      ? declined && identifies
      : Boolean(r.answer?.answered && c.expectCites!.some((f) => r.answer!.citations.includes(f))) && identifies;
    return {
      id: c.id, origin: c.origin, passed,
      detail: !identifies ? 'comment did not identify itself as automated'
        : c.expectDecline ? (declined ? 'declined, as it should' : 'answered when it should have declined')
        : r.answer?.answered ? `cited ${r.answer.citations.join(', ')}` : 'declined',
    };
  });
}
