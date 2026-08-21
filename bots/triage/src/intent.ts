import type { Issue } from './triage.js';

/**
 * WHAT KIND OF ISSUE IS THIS? Asked FIRST, before anything else.
 *
 * ------------------------------------------------------------------------------------------
 * THE DEFECT THIS FILE EXISTS TO FIX IS A CLASS, NOT AN INSTANCE
 * ------------------------------------------------------------------------------------------
 * The bot assumed every issue was a defect report. It matched failure modes first, and when
 * nothing matched it reached for the triage template - "Thanks for the report", an `unmatched`
 * label, a demand for `usewarden status --json` and a Node version, and a warning about pasting
 * API keys. A beginner who asked "confused - do i need to pay for something?" got all four, in
 * public, from a bot posting under the maintainer's name.
 *
 * That was fixed once already, at the instance level, by narrowing a signal. It came back in a
 * new instance the very next time, because the shape was never addressed: the credential warning
 * was a FOOTER, appended to every comment the bot ever wrote, and the diagnostics ask came from a
 * template chosen before anyone had established what the person wanted.
 *
 * So intent is now established first and everything else is downstream of it. A question gets an
 * answer from the documentation, quoted and cited, and NOTHING ELSE - no diagnostics, no
 * credential warning, no "thanks for the report".
 *
 * ------------------------------------------------------------------------------------------
 * THE RULE THAT SEPARATES A BUG FROM A QUESTION
 * ------------------------------------------------------------------------------------------
 * Not grammar. "any chance of windows support" is grammatically a question and is a feature
 * request; "why did it stop my agent" is a question about behaviour, and "blocks stuff it
 * shouldnt" is a defect report - and neither of those two has a question mark.
 *
 *     A BUG REPORT CLAIMS THE TOOL IS WRONG. A QUESTION ASKS WHAT THE TOOL DOES.
 *
 * That distinction survives beginner phrasing, which is the whole problem: beginners do not write
 * "expected X, observed Y", they write "it just hangs" and "did i break it". It also fails safe.
 * When nothing is recognised the answer is `question`, never `bug`, because the cost of the two
 * mistakes is wildly asymmetric: answering a defect report with a documentation quote is a wasted
 * comment a human then reads, while triaging a beginner's question as a defect report is the
 * failure that already happened twice in public.
 */

export type Intent = 'question' | 'bug' | 'feature' | 'security';

export interface IntentResult {
  intent: Intent;
  /** The signal that decided it, for tests and for the run log. Never shown to the reporter. */
  why: string;
}

const hay = (i: Issue): string => `${i.title}\n${i.body}`.toLowerCase();

/**
 * A report of getting AROUND a control. Deliberately narrow: merely naming `.env` or "api key" is
 * not a vulnerability report, and treating it as one is how a beginner got told to file a
 * security advisory. The claim has to be that something got THROUGH.
 */
const SECURITY: RegExp[] = [
  /\b(bypass|by-?pass|get (a)?round|got (a)?round|way (a)?round|work(ed|s)? around)\b[^.\n]{0,60}\b(block|deny|guard|rule|protection|usewarden|control)/,
  /\b(block|deny|guard|rule|protection|usewarden|control)[^.\n]{0,60}\b(bypass|by-?pass|got (a)?round|way (a)?round)\b/,
  /\b(still (gets?|got) through|not blocked|wasn'?t blocked|slipped through|leak(ed|s)?|expos(ed|es|ure))\b[^.\n]{0,80}\b(\.env|secret|credential|key|token|password)/,
  /\b(\.env|secret|credential|token|password)\b[^.\n]{0,80}\b(still (gets?|got) through|not blocked|wasn'?t blocked|slipped through|leak(ed|s)?|expos(ed|es))\b/,
];

/**
 * A claim that the tool is WRONG - malfunctioning, or doing something it should not. Not a
 * description of the tool working as designed, which is what "why did it stop my agent" is.
 */
const BUG: RegExp[] = [
  // it does not work
  /\b(crash(es|ed|ing)?|hangs?|hanging|freez(e|es|ing)|stuck|times? out|timed out|not working|doesn'?t work|does not work|won'?t (start|run|work)|broke(n)?|fails?|failed|error|exception|traceback|stack ?trace)\b/,
  // it refuses something it should accept - a rejected credential is a defect report, not a
  // question, and it is the one case where the credential warning genuinely belongs.
  /\b(reject(s|ed|ing)?|refused|denied|unauthori[sz]ed|invalid|not accepted|401|403)\b/,
  // it does something it should not
  /\b(should ?n'?t|should not|shouldnt)\b[^.\n]{0,40}\b(block|stop|do|happen|be)/,
  // -ing AND -ed FORMS. The list was `blocks?|stops?`, which matches "block", "blocks", "stop"
  // and "stops" and NOT "blocking", "blocked", "stopping" or "stopped" - the four forms someone
  // actually uses when describing something that already happened to them. "IT KEEPS STOPPING A
  // COMPLETELY NORMAL COMMAND" was classified as a QUESTION on that gap alone, and so was every
  // other past-tense over-blocking report. A signal list that only recognises the present tense
  // recognises complaints nobody makes.
  /\b(block(s|ed|ing)?|stop(s|ped|ping)?|refus(e|es|ed|ing)|prevent(s|ed|ing)?|denie[sd]|denying)\b[^.\n]{0,40}\b(normal|legit|legitimate|valid|safe|fine|ordinary|everything|harmless)\b/,
  /\b(false positive|over.?block|too aggressive|unusable|useless)\b/,

  // ----------------------------------------------------------------------------------------
  // WRONGNESS WITHOUT A MALFUNCTION WORD.
  //
  // Every rule above waits for the reporter to name a fault - crash, error, hang, unprotected,
  // "shouldn't". Plenty of real defect reports never do. They describe a COST instead: it did
  // this repeatedly, for no reason, and I lost an afternoon to it. "installed it this morning
  // and it has blocked my build twice for no reason. wasted my whole afternoon." contains no
  // word from any list above and is unambiguously a defect report to any human who reads it.
  //
  // These are deliberately narrow, because the nearest QUESTION is very close: "why did it stop
  // my agent - i was just trying to run a command and it blocked it. im not sure what i did
  // wrong" must stay a question. The discriminator is not the blocking, which both describe. It
  // is whether the reporter attributes the fault to the TOOL or to themselves - so every rule
  // below keys on an explicit claim of wrongness or cost, never on the blocking itself.
  // ----------------------------------------------------------------------------------------
  /\bfor no (good )?reason\b|\bno reason at all\b|\bwithout (any )?(good )?reason\b/,
  /\bwast(e|es|ed|ing)\b[^.\n]{0,40}\b(hour|hours|day|days|afternoon|morning|evening|time|week|weeks)\b/,
  /\b(had|have|having) to (work|code|hack|get) around\b|\bwork(ed|ing)? around it\b/,
  /\b(keeps?|kept)\b[^.\n]{0,30}\b(block(ing)?|stopp?(ing)?|fail(ing)?|crash(ing)?|break(ing)?|hang(ing)?|refusing|denying)\b/,
  /\b(i|we) (run|use|do|call)\b[^.\n]{0,30}\b(all the time|every day|constantly|daily|dozens of times|hundreds of times)\b/,
  // a state it reports that reads as a fault
  /\b(unprotected|tampered|policy_invalid)\b/,
  // the shape of a report: versions, exit codes, logs pasted in
  /\bexit(ed|s)? (with )?(code )?[1-9]\b/,
  /\bnode v?\d+\.\d+/,
  /\beacces|eperm|enoent|posix_spawn\b/,
];

/** Asking for something that does not exist yet. */
const FEATURE: RegExp[] = [
  /\b(any chance of|would love|it would be (great|nice|good)|could you (add|support)|please add|feature request|any plans?|plans? to (add|support)|on the roadmap|roadmap|when will you|will you (ever )?(add|support)|is that something you might add|support for)\b/,
  /\b(add|support)\b[^.\n]{0,25}\b(windows|linux|vscode|jetbrains|neovim|emacs|zed)\b/,
];

/**
 * Asking what the tool does. Kept broad on purpose - it is the safe default, so it does not need
 * to fight for cases, and the list is here mostly to make the decision explainable in `why`.
 */
const QUESTION: RegExp[] = [
  /\?/,
  /^\s*(how|what|why|when|where|which|who|does|do|can|is|are|will|should|would|could|has|have|any)\b/m,
  /\b(do i (need|have to)|does (it|this)|can i|is (it|this)|how (do|much|many)|what (is|does|happens)|where does|is there)\b/,
  /\b(just checking|wondering|curious|not sure if|question)\b/,
];

const first = (list: RegExp[], h: string): string | null => {
  for (const re of list) if (re.test(h)) return re.source.slice(0, 60);
  return null;
};

/**
 * PRECEDENCE: security > bug > feature > question.
 *
 * Security first because a real bypass report must never be softened into a documentation
 * answer - narrowing the security route so beginners are not alarmed must not stop a genuine
 * report reaching it. Feature ahead of question because "any chance of windows support" is a
 * question by grammar and a feature request by intent, and the corpus has no roadmap to quote:
 * answering it from whatever scores highest is how a bot invents a plan.
 */
export function classifyIntent(issue: Issue): IntentResult {
  const h = hay(issue);

  const sec = first(SECURITY, h);
  if (sec) return { intent: 'security', why: `security signal: ${sec}` };

  const bug = first(BUG, h);
  if (bug) return { intent: 'bug', why: `wrongness claim: ${bug}` };

  const feat = first(FEATURE, h);
  if (feat) return { intent: 'feature', why: `asks for something absent: ${feat}` };

  const q = first(QUESTION, h);
  if (q) return { intent: 'question', why: `interrogative: ${q}` };

  // Nothing recognised. `question`, never `bug` - see the header. The worst case is a
  // documentation quote on something that was not a question, which a human then reads anyway.
  return { intent: 'question', why: 'no signal; defaulting to question, which fails safe' };
}
