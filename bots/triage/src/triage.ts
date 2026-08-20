import { AGENT_SIGNALS, ALLOWED_LABELS, FAILURE_MODES, type FailureMode, type Route } from './knowledge.js';
import { assertAnswerIsSafe, botProseOnly, buildAnswer, type Answer } from './answer.js';
import type { Corpus } from './corpus.js';

/**
 * The triage decision — a PURE function of the issue text.
 *
 * Deliberately pure and deliberately deterministic, for the same reason usewarden's own Layer 1
 * is: a decision you can reproduce from the input is a decision you can test, and a bot that
 * posts to a public repository under the maintainer's name should be the most testable thing in
 * the project, not the least.
 *
 * An optional LLM pass exists (`classify.ts`) and runs ONLY when this returns `unmatched`. That
 * ordering is the same one the spec fixes for the product: deterministic first, zero cost, every
 * event; model second, sampled, never able to overturn the first.
 *
 * ------------------------------------------------------------------------------------------
 * THINGS THIS BOT MUST NEVER DO. Each has a test.
 * ------------------------------------------------------------------------------------------
 *   - claim anything is fixed, or that it knows the cause;
 *   - close, lock, assign, or edit an issue;
 *   - post without identifying itself as automated;
 *   - post more than once on the same issue;
 *   - apply a label outside ALLOWED_LABELS;
 *   - ask for anything that could contain a credential.
 */

export interface Issue {
  number: number;
  title: string;
  body: string;
  /** Login of whoever opened it, used only to detect the bot's own issues. */
  user: string;
}

export interface TriageResult {
  route: Route;
  matches: FailureMode[];
  labels: string[];
  comment: string;
  /** True when the deterministic pass found nothing and an LLM pass could be worth running. */
  needsClassifier: boolean;
  /** Present when the issue reads as a question and the corpus had something to quote. */
  answer?: Answer;
}

/** Wording the bot is forbidden from using. Asserted over every generated comment. */
export const FORBIDDEN_PHRASES: RegExp[] = [
  /\bfixed\b/i,
  /\balready resolved\b/i,
  /\bthis is a duplicate\b/i,
  /\bclosing\b/i,
  /\bwon'?t fix\b/i,
  /\bworks for me\b/i,
  /\bi (have |'ve )?(fixed|resolved|patched)\b/i,
];

const IDENTITY = '_🤖 **Automated triage — I am a bot.** I match the issue text against this '
  + "project's own recorded defects and quote from its documents. **Everything substantive above "
  + 'is a direct quotation from a file in this repository, linked so you can check it.** I do not '
  + 'answer from general knowledge, I have not reproduced anything, I cannot fix anything, I never '
  + 'close issues, and I never promise a timeline. A human reads every issue._';

const NEVER_PASTE = '**Please never paste an API key, token, or `.env` contents into an issue.** '
  + '`usewarden status --json` and `usewarden judge-check` are both built to report what a '
  + 'maintainer needs without ever printing a credential value.';

const ENVIRONMENT_ASK = [
  'To make this actionable, could you add:',
  '',
  '```bash',
  'usewarden status --json     # protection state, per agent, machine-readable',
  'node --version              # usewarden requires >= 22.13',
  '```',
  '',
  'and which agent produced the behaviour (Claude Code, Cursor, Gemini CLI, Copilot CLI, Codex, '
  + 'OpenCode) and its version.',
].join('\n');

function haystack(issue: Issue): string {
  return `${issue.title}\n${issue.body}`.toLowerCase();
}

/** Does the issue already carry the environment information the bot would otherwise ask for? */
export function hasEnvironmentInfo(issue: Issue): boolean {
  const h = haystack(issue);
  const hasStatus = /usewarden status|"overall"\s*:|protection state/.test(h);
  const hasNode = /node[^\n]{0,20}v?2[2-9]\.\d+|node --version|node version/.test(h);
  return hasStatus && hasNode;
}

export function matchFailureModes(issue: Issue): FailureMode[] {
  const h = haystack(issue);
  return FAILURE_MODES.filter((m) => {
    if (m.antiSignals?.some((re) => re.test(h))) return false;
    return m.signals.some((re) => re.test(h));
  });
}

function agentLabels(issue: Issue): string[] {
  const h = haystack(issue);
  return AGENT_SIGNALS.filter(([, re]) => re.test(h)).map(([label]) => label);
}

/**
 * Does this issue read as a QUESTION rather than a defect report? Questions get a retrieval
 * answer; reports get failure-mode matching. Both get the environment ask.
 */
export function looksLikeQuestion(issue: Issue): boolean {
  const h = `${issue.title}\n${issue.body}`.toLowerCase();
  return /\?/.test(issue.title)
    || /^(how|what|why|when|which|does|do|can|is|are|will|should)\b/.test(issue.title.trim().toLowerCase())
    || /\b(how do i|what does|is there a way|does this|can i|what happens if)\b/.test(h);
}

export function triage(issue: Issue, corpus?: Corpus): TriageResult {
  const matches = matchFailureModes(issue);
  const hasEnv = hasEnvironmentInfo(issue);

  // Security routing wins over everything: a possible credential exposure is not a "needs-info".
  const security = matches.filter((m) => m.route === 'security');
  const route: Route = security.length > 0 ? 'security'
    : matches.length === 0 ? 'unmatched'
    : !hasEnv ? 'needs-info'
    : (matches.find((m) => m.route === 'possible-regression') ? 'possible-regression' : 'likely-known');

  // Labels are decided AFTER retrieval, because an answered question is not "unmatched" - it is
  // a question that got an answer, and labelling it for a human to read properly is noise.
  const baseLabels = [
    ...matches.flatMap((m) => m.labels),
    ...agentLabels(issue),
  ];

  // Retrieval runs whenever there is a corpus: a defect report often contains a question too,
  // and a quotation from the repo costs nothing and can only help.
  let answer: Answer | undefined;
  if (corpus) {
    const query = `${issue.title} ${issue.body}`.slice(0, 2000);
    const a = buildAnswer(corpus, query, 2, issue.title);
    // An unanswered retrieval is only worth showing when there is nothing else to say.
    if (a.answered || (matches.length === 0 && looksLikeQuestion(issue))) answer = a;
  }

  const answered = Boolean(answer?.answered);
  // A question that got a quoted answer is `question`, not `unmatched` and not `needs-info`.
  // Asking someone who has not installed it yet for `usewarden status --json` is worse than
  // useless: it reads as a bot that did not understand the question.
  const finalRoute: Route = answered && matches.length === 0 ? 'likely-known' : route;
  const labels = [...new Set([
    ...baseLabels,
    ...(answered && matches.length === 0 ? ['question'] : []),
    ...(!answered && route === 'needs-info' ? ['needs-info'] : []),
    ...(!answered && route === 'unmatched' ? ['unmatched'] : []),
  ])].filter((l) => ALLOWED_LABELS.includes(l)).sort();

  const askForEnv = !hasEnv && !answered;
  const comment = renderComment(issue, matches, route, !askForEnv, answer);
  assertAnswerIsSafe(comment);

  return {
    route: finalRoute,
    matches,
    labels,
    comment,
    needsClassifier: matches.length === 0 && !answered,
    ...(answer ? { answer } : {}),
  };
}

export function renderComment(
  issue: Issue, matches: FailureMode[], route: Route, hasEnv: boolean, answer?: Answer,
): string {
  // "Thanks for the report" is wrong for someone asking a question before they have installed
  // anything. Small, and it is the first thing they read.
  const out: string[] = [answer?.answered && matches.length === 0
    ? 'Thanks for asking — here is the answer from the documentation.'
    : 'Thanks for the report.', ''];

  if (answer) { out.push(answer.body, ''); }

  // The security notice is deliberately AFTER the answer and phrased conditionally. An earlier
  // version led with it and told anyone who used the words "api key" to close their issue and
  // file a vulnerability advisory - including someone simply asking whether a key is required.
  // Alarming a beginner who asked a normal question is a real cost, not a safe default.
  if (route === 'security') {
    out.push('---',
      '',
      '*If what you are reporting is a way to get **around** one of usewarden\'s credential '
      + 'controls, that is a vulnerability rather than a bug — please report it privately via '
      + '[the advisory form](https://github.com/djayamah/usewarden/security/advisories/new) '
      + 'instead of here. If it is an ordinary question or bug, this issue is exactly the right '
      + 'place and no action is needed.*',
      '',
      NEVER_PASTE,
      '');
  }

  if (matches.length > 0) {
    out.push(matches.length === 1
      ? '**This resembles a failure mode this project has hit before.** That is a starting point, not a diagnosis:'
      : '**This resembles more than one failure mode this project has hit before.** Starting points, not diagnoses:',
      '');
    for (const m of matches) {
      out.push(`- **${m.id}** — ${m.summary}`);
      out.push(`  - *What would confirm or rule it out:* ${m.ask}`);
      out.push(`  - *Where a human can check:* ${m.evidence}`);
    }
    out.push('');
  } else if (!answer?.answered) {
    out.push("I could not match this to any failure mode I know about, so I have labelled it "
      + '`unmatched` for a human to read properly. That is not a judgement about the report — it '
      + 'usually just means it is something new.', '');
  }

  if (!hasEnv) out.push(ENVIRONMENT_ASK, '');
  if (route !== 'security') out.push(NEVER_PASTE, '');

  out.push('---', IDENTITY);
  return out.join('\n');
}

/** Guard run over every comment before it is posted. Throws rather than posting something wrong. */
export function assertCommentIsSafe(comment: string): void {
  // Quoted lines are the reader seeing what a file says; everything else is the bot talking.
  // See botProseOnly() and D-091 for why this distinction is load-bearing rather than a loophole.
  const prose = botProseOnly(comment);
  for (const re of FORBIDDEN_PHRASES) {
    if (re.test(prose)) {
      throw new Error(`triage bot refused to post: bot prose matches forbidden phrase ${re}`);
    }
  }
  if (!comment.includes('Automated triage')) {
    throw new Error('triage bot refused to post: comment does not identify itself as automated');
  }
}
