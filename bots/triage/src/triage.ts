import { AGENT_SIGNALS, ALLOWED_LABELS, FAILURE_MODES, type FailureMode, type Route } from './knowledge.js';
import { assertAnswerIsSafe, botProseOnly, buildAnswer, decomposeQuestions, type Answer } from './answer.js';
import type { Corpus } from './corpus.js';
import { classifyIntent, type Intent } from './intent.js';

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
  /** What the reporter WANTED, decided before anything else. See intent.ts. */
  intent: Intent;
  /** Why that intent was chosen. For the run log and the tests; never shown to the reporter. */
  intentWhy: string;
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

/**
 * The disclosure claimed "everything substantive above is a direct quotation" even when the bot
 * had quoted NOTHING — which is a false statement, made by the component whose entire purpose is
 * not making false statements. It is now conditional on there being a quotation.
 */
function identity(quoted: boolean): string {
  return '_🤖 **Automated triage — I am a bot.** I match the issue text against this '
    + "project's own recorded defects and quote from its documents. "
    + (quoted
      ? '**Everything substantive above is a direct quotation from a file in this repository, '
        + 'linked so you can check it.** '
      : '**I found nothing in those documents that answers this, so I have quoted nothing and '
        + 'guessed at nothing.** ')
    + 'I do not answer from general knowledge, I have not reproduced anything, I cannot fix '
    + 'anything, I never close issues, and I never promise a timeline. A human reads every issue._';
}

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

/**
 * THE CORPUS IS REQUIRED, AND IT USED TO BE OPTIONAL.
 *
 * That single `?` put a wrong answer on the public repository. `run.ts` — the ONLY call site that
 * runs in production — called `triage(issue)` and got a bot with no documents at all, so every
 * real issue was answered "I could not find an answer to this in the published documents". It
 * reported a retrieval failure as a documentation gap, which is worse than being wrong: it told
 * the maintainer their docs were missing things that were sitting in the README.
 *
 * Every other call site — three eval sets and twenty-odd tests — passed a corpus explicitly. So
 * the evals scored 20/20, 12/12 and 23/23 against a code path the bot does not take, and nothing
 * anywhere could see it. An optional parameter is a default, and this one defaulted to "know
 * nothing".
 *
 * Required now, so omitting it is a compile error rather than a silent decline.
 */
export function triage(issue: Issue, corpus: Corpus): TriageResult {
  // ---------------------------------------------------------------------------------------
  // INTENT FIRST. Everything below is downstream of it.
  //
  // It used to be the other way round: failure modes were matched first, and when nothing
  // matched the defect-triage template went out regardless of what the person had asked. That
  // shape is what put "Thanks for the report", a demand for `usewarden status --json` and a
  // credential warning under a beginner's question about pricing, in public. Narrowing signals
  // fixed two instances of it and could never fix the class.
  // ---------------------------------------------------------------------------------------
  const { intent, why: intentWhy } = classifyIntent(issue);

  const matches = intent === 'question' || intent === 'feature' ? [] : matchFailureModes(issue);
  const hasEnv = hasEnvironmentInfo(issue);

  // A FEATURE REQUEST gets no retrieval answer at all. The corpus documents what usewarden does,
  // not what it will do; answering "any chance of windows support" from whatever scores highest
  // is how a bot invents a plan it has no standing to promise.
  let answer: Answer | undefined;
  if (intent !== 'feature') {
    const query = `${issue.title} ${issue.body}`.slice(0, 2000);
    // The intent is passed in rather than sniffed out of the text. Beginner questions rarely
    // carry a question mark, and `?`-sniffing is what let DECISIONS.md answer a pricing question.
    // THREE quotations for a question, two for a bug report. Someone who asks three things
    // deserves three answers; two slots against a body that asks about cost AND about privacy
    // means one of them goes unanswered, and it will be the one the retriever was least sure
    // about - which is exactly the one that needed answering. On a single-question issue the
    // extra slot simply goes unused, because the floors still have to clear.
    // ONE SLOT PER QUESTION ASKED, not a fixed three.
    //
    // Three was a guess that happened to fit the issues seen so far, and issue #14 asked FOUR
    // things - free/paid, install, use, monitor. With a hard cap of three, one question loses no
    // matter how good retrieval is, and the reader is told the documentation does not cover
    // something it does cover. The cap now follows what was actually asked, floored at 3 so a
    // single-question issue is unchanged and ceilinged at 5 so a wall of text cannot produce a
    // wall of quotations.
    const askedCount = intent === 'question' ? decomposeQuestions(query).length : 0;
    const slots = intent === 'question' ? Math.min(5, Math.max(3, askedCount)) : 2;
    const a = buildAnswer(corpus, query, slots, issue.title,
      intent === 'question');
    // For a question the retrieval result is the whole comment, so it is shown either way -
    // including when it declined, because "I could not find this" is the honest answer and
    // silence is not. For a bug report it is a bonus and only shown when it found something.
    if (a.answered || intent === 'question') answer = a;
  }
  const answered = Boolean(answer?.answered);

  const security = matches.filter((m) => m.route === 'security');
  const route: Route =
      intent === 'security' ? 'security'
    : security.length > 0 ? 'security'
    // THE THREE STATES THAT USED TO SHARE ONE NAME. See the Route doc comment for why this
    // matters more than it looks: a question the docs cannot answer is a documentation defect
    // with an owner and a fix, and it was previously indistinguishable in the queue from a bug
    // report nobody could parse.
    : intent === 'feature' ? 'feature'
    : intent === 'question' ? (answered ? 'likely-known' : 'docs-gap')
    : matches.length === 0 ? 'unmatched'
    : !hasEnv ? 'needs-info'
    : (matches.find((m) => m.route === 'possible-regression') ? 'possible-regression' : 'likely-known');

  const labels = [...new Set([
    ...matches.flatMap((m) => m.labels),
    ...agentLabels(issue),
    ...(intent === 'question' ? ['question'] : []),
    ...(intent === 'feature' ? ['enhancement'] : []),
    ...(intent === 'security' ? ['security'] : []),
    // `unmatched` means "a human needs to read this properly". A question that got a quoted
    // answer is not unmatched, and labelling it so is noise on top of a correct answer.
    //
    // A question that got NO answer is not unmatched either — it is a documentation gap, which is
    // a different job for a different person, and `docs-gap` says so. `enhancement` already
    // carries the feature case, so a feature request no longer takes `unmatched` as well.
    ...(intent === 'question' && !answered ? ['docs-gap'] : []),
    ...(intent === 'bug' && matches.length === 0 ? ['unmatched'] : []),
    ...(intent === 'bug' && matches.length > 0 && !hasEnv ? ['needs-info'] : []),
  ])].filter((l) => ALLOWED_LABELS.includes(l)).sort();

  const comment = renderComment(issue, matches, route, hasEnv, answer, intent);
  assertAnswerIsSafe(comment);

  return {
    intent,
    intentWhy,
    route,
    matches,
    labels,
    comment,
    needsClassifier: !answered && matches.length === 0 && intent !== 'feature',
    ...(answer ? { answer } : {}),
  };
}

export function renderComment(
  issue: Issue, matches: FailureMode[], route: Route, hasEnv: boolean, answer?: Answer,
  intent: Intent = 'bug',
): string {
  const answered = Boolean(answer?.answered);

  // -----------------------------------------------------------------------------------------
  // A QUESTION GETS AN ANSWER AND NOTHING ELSE.
  //
  // No "thanks for the report", no failure-mode template, no environment ask, and no credential
  // warning. Every one of those was in the comment a beginner received for asking whether the
  // tool costs money, and each one was individually defensible - the credential warning in
  // particular was a footer on EVERY comment the bot wrote, which is exactly why it reached
  // someone it had nothing to do with. Boilerplate that goes out regardless of what was asked
  // is boilerplate nobody chose to send.
  // -----------------------------------------------------------------------------------------
  if (intent === 'question') {
    const out: string[] = [answered
      ? 'Thanks for asking — here is the answer from the documentation.'
      : 'Thanks for asking.', ''];
    if (answer) out.push(answer.body, '');
    if (!answered) {
      out.push('I could not find an answer to this in the published documents, so rather than '
        + 'guess I have left it for a human to answer properly. Nothing is wrong with the '
        + 'question — it usually just means the docs do not cover it yet.', '');
    }
    out.push('---', identity(answered));
    return out.join('\n');
  }

  // -----------------------------------------------------------------------------------------
  // A FEATURE REQUEST gets an acknowledgement, and no invented plan.
  // -----------------------------------------------------------------------------------------
  if (intent === 'feature') {
    return [
      'Thanks — this reads as a feature request rather than a bug, so I have labelled it '
      + '`enhancement` and left it for a human.',
      '',
      'I answer only from this repository\'s published documents, and they describe what '
      + 'usewarden does today rather than what it will do. There is no roadmap document here for '
      + 'me to quote, so I am not going to guess at one — a maintainer will reply.',
      '',
      '---',
      identity(false),
    ].join('\n');
  }

  // -----------------------------------------------------------------------------------------
  // A DEFECT REPORT, or a security report. This is the only path the triage template runs on.
  // -----------------------------------------------------------------------------------------
  const out: string[] = ['Thanks for the report.', ''];

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
  } else if (!answered) {
    out.push("I could not match this to any failure mode I know about, so I have labelled it "
      + '`unmatched` for a human to read properly. That is not a judgement about the report — it '
      + 'usually just means it is something new.', '');
  }

  if (!hasEnv) out.push(ENVIRONMENT_ASK, '');
  if (route !== 'security') out.push(NEVER_PASTE, '');

  out.push('---', identity(answered));
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
