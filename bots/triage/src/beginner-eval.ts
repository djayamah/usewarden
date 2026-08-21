import { Corpus } from './corpus.js';
import { triage, type Issue } from './triage.js';
import { botProseOnly } from './answer.js';

/**
 * THE BEGINNER EVAL.
 *
 * The original eval set gave false confidence TWICE - it sat at 20/20 while the bot posted a
 * failing comment on a real public issue, and again while it reached for the triage template on a
 * question. Both times the reason was the same: every question in it is one well-formed sentence,
 * ending in a question mark, using the project's own vocabulary. Real issue bodies are none of
 * those things. They are lowercase, they ramble, they apologise, they ask two things at once, and
 * they use the words the person already had rather than the words the documentation uses.
 *
 * So this set is deliberately built out of the phrasing that broke it:
 *   - lowercase, unpunctuated, no question mark at all in some
 *   - vague and non-technical ("do i have to give it my code")
 *   - long rambling bodies whose real question is one clause in the middle, surrounded by
 *     greetings and apologies that DILUTE retrieval - the exact mechanism of the live failure
 *   - and, importantly, real BUG REPORTS phrased just as informally, because a set made only of
 *     questions would train the bot to answer everything and never triage anything.
 *
 * WHAT IS SCORED, AND WHY IT IS NOT JUST "did it answer"
 *
 * The live failure was not a retrieval failure. Retrieval was ONE input to a routing decision
 * that had already been made: the bot assumed every issue was a defect report, matched failure
 * modes first, and reached for the triage template when nothing matched. A beginner asking
 * whether they have to pay got "Thanks for the report", an `unmatched` label, a request for
 * `usewarden status --json` from someone who had installed nothing, and a warning about pasting
 * API keys.
 *
 * Each case therefore asserts the INTENT, and then asserts what that intent forbids. A question
 * that gets a correct citation AND a diagnostic request is scored as a FAILURE here, because that
 * is what actually happened in public.
 */

export type Intent = 'question' | 'bug' | 'feature' | 'security';

export interface BeginnerCase {
  id: string;
  title: string;
  body: string;
  /** What a maintainer reading this issue would say it is. */
  expectIntent: Intent;
  /** Repo-relative files, ANY of which is a correct citation. Omitted when a decline is correct. */
  expectCites?: string[];
  /** True when the corpus genuinely does not answer it and saying so is the pass. */
  expectDecline?: boolean;
  /** Why this case exists - so the set can be audited rather than trusted. */
  note: string;
}

/** Phrases a question must never receive. Each one is something the bot actually did. */
export const QUESTION_MUST_NOT = [
  { re: /Thanks for the report/i, why: 'called a question a report' },
  { re: /usewarden status --json/i, why: 'asked for diagnostics from someone who may have installed nothing' },
  { re: /node --version/i, why: 'asked for a Node version from someone asking a question' },
  { re: /never paste an API key|do not paste.{0,20}key/i, why: 'warned a question-asker about pasting credentials' },
  { re: /could not match this to any failure mode/i, why: 'ran the defect-triage template on a question' },
  { re: /which agent produced the behaviour/i, why: 'asked which agent produced behaviour nobody reported' },
] as const;

export const BEGINNER_SET: BeginnerCase[] = [
  // ---- short, lowercase, vague. The live failure and its siblings. ------------------------
  {
    id: 'beg-pay', title: 'confused - do i need to pay for something?',
    body: 'hi, saw this on github. sorry if this is obvious, im not very technical. '
      + 'does it need one of those api keys to work? and does it upload my project anywhere',
    expectIntent: 'question', expectCites: ['README.md', 'docs/TELEMETRY.md'],
    note: 'THE live failure, verbatim from public issue #9. Two questions wrapped in an apology.',
  },
  {
    id: 'beg-unprotected', title: 'it says unprotected??',
    body: 'i ran the status thing and it says UNPROTECTED in big letters. did i break it',
    expectIntent: 'bug', expectCites: ['README.md'],
    note: 'Reads as alarm, is a real state report. A bug intent here is correct - but the '
      + 'answer must still come from the docs, not from a diagnostics demand alone.',
  },
  {
    id: 'beg-slow', title: 'does this slow my agent down',
    body: 'no question mark, no punctuation, and the word "latency" never appears - which is the '
      + 'word the documentation uses.',
    expectIntent: 'question', expectCites: ['README.md'],
    note: 'No question mark at all. The old looksLikeQuestion leaned on one.',
  },
  {
    id: 'beg-why-stop', title: 'why did it stop my agent',
    body: 'i was just trying to run a command and it blocked it. im not sure what i did wrong',
    expectIntent: 'question', expectCites: ['README.md'],
    note: 'Sounds like a complaint, is a question about what the tool does.',
  },
  {
    id: 'beg-my-code', title: 'do i have to give it my code',
    body: 'a bit worried about privacy here. where does the code go',
    expectIntent: 'question', expectCites: ['docs/TELEMETRY.md', 'README.md'],
    note: 'Non-technical privacy phrasing. Never uses "telemetry", which is the corpus word.',
  },
  {
    id: 'beg-free', title: 'is this free',
    body: 'just checking before i install it',
    expectIntent: 'question', expectCites: ['README.md'],
    note: 'Three words. Short queries are where a coverage FRACTION misleads most.',
  },

  // ---- long and rambling: the real question is one clause in the middle -------------------
  {
    id: 'beg-ramble-key', title: 'hello! quick question from a new user (sorry!)',
    body: [
      'hi there, first of all thank you so much for building this, it looks really useful and i',
      'have been looking for something like it for a while. i work mostly on small side projects',
      'and i have been using an ai assistant in my editor for a few months now. a colleague of',
      'mine mentioned this project to me yesterday and i thought i would give it a go over the',
      'weekend. before i do that though i wanted to check one thing because i am on a fairly',
      'tight budget at the moment and i have been burned before by tools that look free and then',
      'turn out to need a paid api plan halfway through setup.',
      '',
      'so my question is basically whether i need an api key to use this or not.',
      '',
      'sorry if this is written up somewhere obvious, i did have a look at the readme but there',
      'is quite a lot in there and i was not sure which part applied to me. thanks again and',
      'sorry for the long message!',
    ].join('\n'),
    expectIntent: 'question', expectCites: ['README.md'],
    note: 'The dilution case. One real clause in 150 words of politeness - exactly the shape '
      + 'that scored 0.19 coverage on the whole body and 0.40 on the sentence.',
  },
  {
    id: 'beg-ramble-privacy', title: 'a few things before i roll this out to my team',
    body: [
      'hey, we are a small team of four and we have been evaluating a few different guardrail',
      'tools this quarter. our security person asked me to check a couple of things before we',
      'put anything on the engineering laptops, which i think is fair enough.',
      '',
      'the main thing she wants to know is what gets sent off the machine, if anything.',
      '',
      'we are not in a regulated industry or anything but we do have a client contract that says',
      'source code cannot leave our infrastructure, so that is the sticking point. happy to read',
      'docs if you point me at the right one. no rush at all, we are not deciding until next month.',
    ].join('\n'),
    expectIntent: 'question', expectCites: ['docs/TELEMETRY.md', 'README.md'],
    note: 'Second dilution case, different vocabulary - "gets sent off the machine".',
  },

  // ---- informally phrased REAL bug reports. A set of only questions trains a yes-bot. -----
  {
    id: 'beg-bug-hang', title: 'it just hangs',
    body: 'every time claude code tries to run anything it sits there forever. i left it 10 '
      + 'minutes. node v22.14. usewarden status --json says protected.',
    expectIntent: 'bug',
    note: 'A real defect report in beginner phrasing, WITH environment info already supplied. '
      + 'The triage template is correct here and asking again for what is already there is not.',
  },
  {
    id: 'beg-bug-blocked-legit', title: 'blocks stuff it shouldnt',
    body: 'it keeps stopping normal commands that are completely fine. this makes it unusable '
      + 'for me. i am using cursor.',
    expectIntent: 'bug',
    note: 'Over-guarding, which this project treats as a real defect, not as the tool working.',
  },

  // ---- a feature request, phrased as a question. Intent is not grammar. -------------------
  {
    id: 'beg-feature-windows', title: 'any chance of windows support',
    body: 'would love to use this but im on windows. is that something you might add',
    expectIntent: 'feature', expectDecline: true,
    note: 'Grammatically a question; a maintainer reads it as a feature request. The corpus '
      + 'does not answer roadmap questions, so declining is the pass - but it must not be '
      + 'triaged as a defect either.',
  },

  // ---- a real security report, phrased informally. Must still route to security. ----------
  {
    id: 'beg-sec-bypass', title: 'i think i found a way round the env blocking',
    body: 'if you use a different command to read it the .env file still gets through and i can '
      + 'see the secret in the transcript. not sure if you knew',
    expectIntent: 'security',
    note: 'The security route must survive the intent change. Narrowing it so beginners are not '
      + 'alarmed must not stop a real bypass report reaching it.',
  },
];

export interface BeginnerResult {
  id: string;
  passed: boolean;
  intentOk: boolean;
  contentOk: boolean;
  detail: string;
}

/**
 * Scores the WHOLE pipeline, not retrieval alone - the defect being measured is a routing
 * defect, and retrieval-only scoring is what hid it twice.
 */
export function runBeginnerEval(
  corpus: Corpus,
  intentOf: (i: Issue) => Intent,
  cases: BeginnerCase[] = BEGINNER_SET,
): BeginnerResult[] {
  return cases.map((c, i) => {
    const issue: Issue = { number: 900 + i, title: c.title, body: c.body, user: 'someone' };
    const r = triage(issue, corpus);
    const intent = intentOf(issue);
    const intentOk = intent === c.expectIntent;

    const problems: string[] = [];
    if (!intentOk) problems.push(`intent ${intent}, expected ${c.expectIntent}`);

    if (c.expectIntent === 'question') {
      // Bot PROSE only. A quoted passage that happens to mention `usewarden status --json` is the
      // documentation speaking; the harm is the BOT demanding it. This is the same distinction
      // the comment-safety guard makes (D-091), and the first version of this check did not make
      // it - it failed a correct comment because a quotation from DECISIONS.md contained the
      // phrase. A scanner must distinguish USING a thing from NAMING it, in a test as much as
      // anywhere else. The footer this exists to catch is bot prose, so it is still caught.
      const prose = botProseOnly(r.comment);
      for (const f of QUESTION_MUST_NOT) {
        if (f.re.test(prose)) problems.push(f.why);
      }
      if (c.expectDecline) {
        if (r.answer?.answered) problems.push('answered a question the corpus does not cover');
      } else {
        const cited = r.answer?.answered
          && c.expectCites!.some((f) => r.answer!.citations.includes(f));
        if (!r.answer?.answered) {
          problems.push(`declined; expected a quotation from ${c.expectCites!.join(' | ')}`);
        } else if (!cited) {
          problems.push(`cited ${r.answer.citations.join(', ')}, expected one of ${c.expectCites!.join(' | ')}`);
        }
      }
    }

    if (c.expectIntent === 'feature' && c.expectDecline && r.answer?.answered) {
      problems.push('answered a roadmap question from documents that do not cover the roadmap');
    }

    if (c.expectIntent === 'security' && r.route !== 'security') {
      problems.push(`routed ${r.route}, expected security`);
    }

    if (c.expectIntent === 'bug' && c.expectCites) {
      const cited = r.answer?.answered && c.expectCites.some((f) => r.answer!.citations.includes(f));
      if (!cited) problems.push('a bug report that a document directly explains got no quotation');
    }

    return {
      id: c.id,
      passed: problems.length === 0,
      intentOk,
      contentOk: problems.filter((p) => !p.startsWith('intent ')).length === 0,
      detail: problems.length === 0 ? 'ok' : problems.join('; '),
    };
  });
}
