/**
 * THE VALUE FIGURES — what usewarden was RIGHT about, not how often it fired.
 *
 * WHY THIS MODULE EXISTS. Every counter on the old dashboard went UP when usewarden was wrong. It
 * showed "59 actions blocked" over a period in which 42 of the 92 real blocks were false
 * positives, and a reader would have concluded that 59 useful things had happened. The tool's own
 * author read that dashboard and then uninstalled the product, which is about as clear a
 * demonstration as one gets that activity is not value.
 *
 * So: precision first, with its denominator and the date of the labelled set it rests on. True
 * positives split by severity, because a caught `rm -rf` above the project is not a caught
 * `chmod 777`. False positives by class, so the number that has to fall is the one on the screen.
 * Coverage beside precision always, never instead of it. Activity is kept, and demoted.
 *
 * THREE RULES, each enforced here rather than promised (docs/METRICS.md §1):
 *
 *   1. DERIVED, NEVER COUNTED. Every figure is a query at the moment you ask.
 *   2. PER ORIGIN. `demo` and `fixture` rows cannot reach a value figure at all — not by being
 *      filtered out at the end, but by never entering: `liveOnly()` is the only way in, and
 *      `tests/value.test.ts` asserts that a database of nothing but demo and fixture rows produces
 *      `unavailable`, not zero.
 *   3. UNAVAILABLE IS NOT ZERO. A figure that cannot be computed says so and says why. "I could
 *      not tell" and "it is fine" are different sentences (CLAUDE.md §4.4). Most users will have
 *      no labelled set, and for them precision is genuinely unknown — which the screen must say,
 *      because a dashboard that renders unknown as 0% or as 100% is lying in one direction or the
 *      other.
 */
import * as fs from 'node:fs';
import type { Store, ReplayRow } from './store.js';
import type { Policy } from './policy/schema.js';
import { replayCorpus, type ReplayResult } from './replay.js';
import { readLabelSet, verifyLabels, score, type LabelSet, type Label } from './labels.js';
import type { ReplayableAction } from './types.js';

/** A figure that may not be computable. There is no third state and no default. */
export type Figure<T> =
  | { available: true; value: T }
  | { available: false; reason: string };

export const unavailable = <T>(reason: string): Figure<T> => ({ available: false, reason });
export const available = <T>(value: T): Figure<T> => ({ available: true, value });

/**
 * How much a catch was worth, derived from the RULE rather than from the label.
 *
 * From the rule on purpose: the severity of a catch is a property of the product and has to be
 * reportable on a machine that has never seen a label set. The labels decide whether a block was
 * *right*; this decides what it was *worth* if it was.
 *
 *   critical  something irreversible reached the model, or the guard itself was being disabled.
 *             A credential in a context window cannot be recalled, and a rewritten policy file
 *             turns every later number on this page into fiction.
 *   high      the agent left the boundary it was given, or destroyed something outside it.
 *   medium    recoverable, or advisory. `chmod 777` is worth knowing about and is not `rm -rf ~`.
 */
export type Severity = 'critical' | 'high' | 'medium';

export const SEVERITY_ORDER: readonly Severity[] = ['critical', 'high', 'medium'];

export function severityOfRule(rule: string, target = ''): Severity {
  // The guard editing its own policy, or a credential store, whichever way it was reached.
  if (/usewarden\.ya?ml/.test(target)) return 'critical';
  if (/\.env|dotenv/i.test(rule)) return 'critical';
  if (/forbidden_paths/.test(rule)) {
    return /\.ssh|\.aws|\.gnupg|Keychain|id_rsa|id_ed25519|\.pem|\.npmrc|\.netrc|\.docker|\.kube|gcloud|azure|\.env/i
      .test(target) ? 'critical' : 'high';
  }
  if (/rm-rf|git-clean-force|dd-to-device|mv-to-devnull|find-delete|infra-destroy|drop-table|force-push|curl-pipe-shell|sudo/
    .test(rule)) return 'high';
  if (/allowed_paths|protect_uncommitted/.test(rule)) return 'high';
  return 'medium';
}

export interface PrecisionFigure {
  pct: number;
  truePositives: number;
  falsePositives: number;
  /** tp + fp. Printed beside the percentage, always. */
  denominator: number;
  unknown: number;
  indeterminate: number;
}

export interface CoverageFigure {
  pct: number;
  caught: number;
  /** The number of TRUE POSITIVES in the labelled corpus. The denominator, printed always. */
  total: number;
}

export interface ClassRow {
  name: string;
  /** How many fired when the corpus was recorded. */
  then: number;
  /** How many still fire under the ruleset being reported. This is the number that must fall. */
  now: number;
}

export interface SeverityRow {
  severity: Severity;
  count: number;
}

export interface ValueReport {
  /** Where the labels came from, so a reader can date the precision figure. */
  labelSet: Figure<{ file: string; labelledAt: string; hash: string; labelled: number }>;
  precision: Figure<PrecisionFigure>;
  coverage: Figure<CoverageFigure>;
  truePositivesBySeverity: Figure<SeverityRow[]>;
  falsePositivesByClass: Figure<ClassRow[]>;
  /** Secondary, and marked as such on every surface that renders it. */
  activity: {
    liveBlocks: number;
    liveWarnings: number;
    liveSessions: number;
    /** Present so a reader can see they are excluded, never added to anything. */
    excludedDemo: number;
    excludedFixture: number;
  };
}

/**
 * THE ONLY WAY INTO A VALUE FIGURE.
 *
 * Not a filter applied at the end - the entry point. A demo or fixture row cannot reach a value
 * figure by any route, because no other function in this module reads the store.
 */
function liveOnly(store: Store): ReplayRow[] {
  return store.replayCorpus('live');
}

/**
 * Recomputes a derived figure a SECOND, independent way and refuses it if the two disagree.
 *
 * docs/METRICS.md §1 requires derived-never-counted; this is the next question, which is what
 * happens when the derivation itself is wrong. A precision figure is three numbers that must add
 * up, and the cheapest way to ship a wrong one is an off-by-one in a filter that no test covers
 * because the test uses the same filter. So the totals are re-added from the row list on read, and
 * a mismatch makes the figure UNAVAILABLE with the discrepancy in the reason - never a silently
 * plausible number.
 */
function checked<T>(what: string, value: T, invariant: () => string | null): Figure<T> {
  const problem = invariant();
  return problem === null ? available(value) : unavailable(`${what}: ${problem}`);
}

export interface ValueInputs {
  store: Store;
  policy: Policy;
  /** Path to the frozen label set, if this machine has one. */
  labelsFile?: string | undefined;
}

export function buildValueReport(inp: ValueInputs): ValueReport {
  const rows = liveOnly(inp.store);
  const blocks = rows.filter((r) => r.action === 'block');
  const warns = rows.filter((r) => r.action !== 'block');

  const activity = {
    liveBlocks: blocks.length,
    liveWarnings: warns.length,
    liveSessions: inp.store.countSessions('live'),
    excludedDemo: inp.store.replayCorpus('demo').length,
    excludedFixture: inp.store.replayCorpus('fixture').length,
  };

  const noLabels = (why: string): ValueReport => ({
    labelSet: unavailable(why),
    precision: unavailable(why),
    coverage: unavailable(why),
    truePositivesBySeverity: unavailable(why),
    falsePositivesByClass: unavailable(why),
    activity,
  });

  if (!inp.labelsFile) {
    return noLabels(
      'no labelled incident set on this machine. Precision is a claim about whether blocks were '
      + 'RIGHT, and only a human reading the incidents can say. See docs/PRECISION.md.',
    );
  }
  if (!fs.existsSync(inp.labelsFile)) {
    return noLabels(`label set not found: ${inp.labelsFile}`);
  }

  let set: LabelSet;
  let expected: string;
  try {
    ({ set, expected } = readLabelSet(inp.labelsFile));
  } catch (e) {
    return noLabels(`label set could not be read: ${(e as Error).message}`);
  }

  const actions = new Map<number, ReplayableAction>();
  for (const r of rows) if (r.replayable) actions.set(r.id, r.replayable);
  const v = verifyLabels(set, expected, actions);
  if (!v.ok) {
    // REFUSED, not degraded. A precision figure from an unverified label set renders exactly like
    // a verified one, and this page is the thing a reader would screenshot.
    return noLabels(`label set REFUSED: ${v.problems.join('; ')}`);
  }

  // THE LABEL SET MUST DESCRIBE *THIS MACHINE'S LIVE CORPUS*, and that is a stricter question than
  // the one `verifyLabels` answers.
  //
  // `verifyLabels` binds each label to the action it describes, but it can only check the ids it is
  // given: hand it an EMPTY map and it falls back to checking the file hash alone. A label set that
  // is internally perfect and describes a corpus this machine does not have would then verify, and
  // coverage would come back as a real figure with a real denominator — 0 of 1 caught — computed
  // entirely from incidents that are not here.
  //
  // Found by test V1, which fills a database with nothing but demo and fixture rows and asserts
  // that no value figure survives. Precision correctly refused (its denominator was empty);
  // coverage did not, because its denominator comes from the LABELS rather than from the corpus.
  const missing = set.labels.filter((l) => !actions.has(l.id));
  if (missing.length > 0) {
    return noLabels(
      `label set describes ${missing.length} incident(s) that are not in this machine's live `
      + 'corpus. Precision and coverage are claims about THIS record; a label set that does not '
      + 'describe it cannot produce them.',
    );
  }

  const results = replayCorpus(blocks, inp.policy);
  const byId = new Map<number, ReplayResult>(results.map((r) => [r.id, r]));
  const blockedNow = (id: number): boolean | null => byId.get(id)?.blockedNow ?? null;
  const s = score(set, blockedNow);
  const labelOf = new Map<number, Label>(set.labels.map((l) => [l.id, l.label]));

  const labelSet = available({
    file: inp.labelsFile,
    labelledAt: set.labelledAt,
    hash: v.hash,
    labelled: set.labels.length,
  });

  const precision: Figure<PrecisionFigure> = s.precision === null
    ? unavailable(
      'nothing in the labelled set still blocks under these rules, so precision has no '
      + 'denominator. That is not 100% and it is not 0%.',
    )
    : checked('precision', {
      pct: s.precision * 100,
      truePositives: s.truePositives,
      falsePositives: s.falsePositives,
      denominator: s.truePositives + s.falsePositives,
      unknown: s.unknown,
      indeterminate: s.indeterminate,
    }, () => {
      // Re-derive the denominator from the rows rather than from the scorer's own accumulators.
      const stillBlocking = set.labels.filter((l) => blockedNow(l.id) === true).length;
      const counted = s.truePositives + s.falsePositives + s.unknown;
      return stillBlocking === counted
        ? null
        : `${stillBlocking} labelled incidents still block but ${counted} were scored`;
    });

  const coverage: Figure<CoverageFigure> = s.coverageTotal === 0
    ? unavailable('the labelled set contains no true positives, so there is nothing to cover.')
    : checked('coverage', {
      pct: (s.coverage ?? 0) * 100,
      caught: s.coverageCaught,
      total: s.coverageTotal,
    }, () => {
      const tpTotal = set.labels.filter((l) => l.label === 'TRUE_POSITIVE').length;
      const tpCaught = set.labels
        .filter((l) => l.label === 'TRUE_POSITIVE' && blockedNow(l.id) === true).length;
      if (tpTotal !== s.coverageTotal) return `denominator ${s.coverageTotal} != ${tpTotal}`;
      if (tpCaught !== s.coverageCaught) return `numerator ${s.coverageCaught} != ${tpCaught}`;
      return null;
    });

  // --- true positives by severity ------------------------------------------------------------
  const sevCounts = new Map<Severity, number>(SEVERITY_ORDER.map((x) => [x, 0]));
  for (const l of set.labels) {
    if (l.label !== 'TRUE_POSITIVE' || blockedNow(l.id) !== true) continue;
    const row = blocks.find((b) => b.id === l.id);
    if (!row) continue;
    const sev = severityOfRule(byId.get(l.id)?.ruleNow ?? row.rule, row.target || row.attempted);
    sevCounts.set(sev, (sevCounts.get(sev) ?? 0) + 1);
  }
  const sevRows = SEVERITY_ORDER.map((severity) => ({ severity, count: sevCounts.get(severity) ?? 0 }));
  const truePositivesBySeverity = checked('true positives by severity', sevRows, () => {
    const total = sevRows.reduce((a, b) => a + b.count, 0);
    return total === s.truePositives ? null : `severities sum to ${total}, precision counted ${s.truePositives}`;
  });

  // --- false positives by class --------------------------------------------------------------
  const classes = new Map<string, ClassRow>();
  for (const l of set.labels) {
    if (l.label !== 'FALSE_POSITIVE') continue;
    const name = l.class ?? '(unclassified)';
    const row = classes.get(name) ?? { name, then: 0, now: 0 };
    row.then++;
    if (blockedNow(l.id) === true) row.now++;
    classes.set(name, row);
  }
  const classRows = [...classes.values()].sort((a, b) => b.now - a.now || b.then - a.then);
  const falsePositivesByClass = checked('false positives by class', classRows, () => {
    const nowTotal = classRows.reduce((a, b) => a + b.now, 0);
    const thenTotal = classRows.reduce((a, b) => a + b.then, 0);
    const labelledFp = set.labels.filter((l) => l.label === 'FALSE_POSITIVE').length;
    if (thenTotal !== labelledFp) return `classes hold ${thenTotal} rows, ${labelledFp} were labelled`;
    return nowTotal === s.falsePositives
      ? null
      : `classes still firing sum to ${nowTotal}, precision counted ${s.falsePositives}`;
  });

  // Referenced so the map is not merely decorative; a label with no matching incident would have
  // been caught by verifyLabels above, and this keeps that guarantee visible.
  void labelOf;

  return { labelSet, precision, coverage, truePositivesBySeverity, falsePositivesByClass, activity };
}

/** Renders a Figure for a terminal or an HTML page. Never invents a number. */
export function renderFigure<T>(f: Figure<T>, render: (v: T) => string): string {
  return f.available ? render(f.value) : 'unavailable';
}

export function figureReason<T>(f: Figure<T>): string {
  return f.available ? '' : f.reason;
}
