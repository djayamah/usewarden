/**
 * REPLAY - run the stored incident corpus against a ruleset it may never have seen.
 *
 * WHY THIS EXISTS. `docs/RETENTION.md` argues that the durable, queryable record is usewarden's
 * only claim nothing else duplicates. A record you cannot re-run answers "what happened" and
 * cannot answer "would this still fire" - which is half of what a record is for, and it is the
 * half you need before you are allowed to tune anything. Every precision figure in
 * `docs/PRECISION.md` is produced by this module.
 *
 * THE FENCE. Replay evaluates actions that were typed months ago against paths that are whatever
 * the agent typed. On this machine that corpus contains paths CLAUDE.md §1 forbids this
 * repository's tooling from reading, writing, statting or resolving. So Layer 1 is called with
 * `filesystem: 'fenced'` and every filesystem-reading check either degrades to message-only or
 * reports itself unevaluable. The fence is PROVED rather than asserted: Layer 1's two filesystem
 * probes are injectable, and `tests/replay.test.ts` R4 hands in stubs that throw - so a fenced
 * replay that reached the disk would fail the test loudly, and the same stubs in `live` mode do
 * throw, which is what stops that assertion from being vacuous.
 */
import * as path from 'node:path';
import type { Policy } from './policy/schema.js';
import type { ReplayableAction, NormalizedEvent, Verdict } from './types.js';
import type { ReplayRow, ReplayProvenance } from './store.js';
import { evaluateLayer1, type Layer1Probes } from './engine/layer1.js';
import { redact } from './util.js';

/**
 * How a replayed incident compares to what was recorded.
 *
 *   `same`         blocked then, blocked now, by the same rule. Nothing changed.
 *   `rule-changed` blocked then and now, but a different rule owns it. Coverage is intact and
 *                  the attribution moved - worth seeing, not a regression.
 *   `now-allowed`  blocked then, allowed now. THE POINT OF A PRECISION FIX when the incident is
 *                  a false positive, and a COVERAGE REGRESSION when it is a true positive. Which
 *                  it is comes from the frozen label file, never from this module.
 *   `now-blocked`  not blocked then, blocked now. New coverage, or a new false positive.
 *   `indeterminate` a rule that decides the verdict could not be evaluated under the fence.
 *   `unreplayable` no faithful input exists for this row at all.
 */
export type ReplayOutcome =
  | 'same' | 'rule-changed' | 'now-allowed' | 'now-blocked' | 'indeterminate' | 'unreplayable';

export interface ReplayResult {
  id: number;
  ts: number;
  origin: string;
  provenance: ReplayProvenance;
  /** The lossy display string, redacted. Shown so a reader can recognise the incident. */
  attempted: string;
  ruleThen: string;
  blockedThen: boolean;
  /** null when the row is unreplayable or indeterminate - never defaulted to false. */
  blockedNow: boolean | null;
  ruleNow: string | null;
  outcome: ReplayOutcome;
  /** Populated for `indeterminate` and `unreplayable`. */
  note?: string;
}

export interface ReplaySummary {
  total: number;
  replayed: number;
  unreplayable: number;
  indeterminate: number;
  blockedThen: number;
  blockedNow: number;
  byOutcome: Record<ReplayOutcome, number>;
}

/**
 * Redacts a stored action for DISPLAY. The single place that does it.
 *
 * The stored action is deliberately written verbatim (D-277), so redaction has to happen at every
 * read. Concentrating it in one exported function is what makes that enforceable: a new display
 * surface either calls this or it is visibly not calling it, and `tests/replay.test.ts` asserts
 * that the two shipped surfaces - `usewarden replay` and the dashboard - both do.
 */
export function redactAction(a: ReplayableAction): ReplayableAction {
  return {
    ...a,
    ...(a.command !== undefined ? { command: redact(a.command) } : {}),
    ...(a.filePath !== undefined ? { filePath: redact(a.filePath) } : {}),
    ...(a.prompt !== undefined ? { prompt: redact(a.prompt) } : {}),
  };
}

/** Rebuilds the NormalizedEvent Layer 1 expects from a stored action. Pure. */
function toEvent(a: ReplayableAction, sessionId: string, ts: number): NormalizedEvent {
  return {
    agent: a.agent,
    event: a.event,
    sessionId,
    cwd: a.cwd,
    ts,
    ...(a.tool ? { tool: a.tool } : {}),
    ...(a.rawTool ? { rawTool: a.rawTool } : {}),
    ...(a.command !== undefined ? { command: a.command } : {}),
    ...(a.filePath !== undefined ? { filePath: a.filePath } : {}),
    ...(a.prompt !== undefined ? { prompt: a.prompt } : {}),
    ...(typeof a.contextFill === 'number' ? { contextFill: a.contextFill } : {}),
  };
}

/**
 * Evaluates one stored action against one policy, with the filesystem fenced.
 *
 * `exceptions` is deliberately EMPTY and not configurable. A replay measures the rules, and a
 * human waiver granted last month for one path would silently turn a block into an allow and
 * flatter the precision figure by an amount nobody could see. Waivers are a property of the
 * session, not of the rule.
 */
export function replayOne(
  a: ReplayableAction,
  policy: Policy,
  probes?: Layer1Probes,
): { verdict: Verdict; unevaluable: string[] } {
  const unevaluable: string[] = [];
  const e = toEvent(a, 'replay', 0);
  const verdict = evaluateLayer1(e, {
    policy,
    filesystem: 'fenced',
    ...(probes ? { probes } : {}),
    onUnevaluable: (rule, why) => unevaluable.push(`${rule}: ${why}`),
    exceptions: [],
    ...(a.branch !== undefined ? { branch: a.branch } : {}),
    ...(a.repoRoot !== undefined ? { repoRoot: a.repoRoot } : {}),
  });
  return { verdict, unevaluable };
}

/**
 * Replays a whole corpus.
 *
 * `blockedThen` is read from what usewarden ACTUALLY DID (`row.action === 'block'`), never
 * re-derived by evaluating the old policy - the old policy is not stored, and guessing at it
 * would make the "then" column a second opinion rather than a record.
 */
export function replayCorpus(rows: readonly ReplayRow[], policy: Policy, probes?: Layer1Probes): ReplayResult[] {
  return rows.map((row) => {
    const blockedThen = row.action === 'block';
    const base = {
      id: row.id,
      ts: row.ts,
      origin: row.origin,
      provenance: row.provenance,
      attempted: redact(row.attempted),
      ruleThen: row.rule,
      blockedThen,
    };

    if (row.provenance === 'unavailable' || !row.replayable) {
      return {
        ...base,
        blockedNow: null,
        ruleNow: null,
        outcome: 'unreplayable' as const,
        note: row.unavailableReason ?? 'no replay input',
      };
    }

    const { verdict, unevaluable } = replayOne(row.replayable, policy, probes);
    const blockedNow = verdict.decision === 'deny';

    // A check that could not run only makes the ROW indeterminate when it could have changed the
    // answer. If something else blocked the action anyway, the verdict stands on its own feet.
    if (unevaluable.length > 0 && !blockedNow) {
      return {
        ...base,
        blockedNow: null,
        ruleNow: null,
        outcome: 'indeterminate' as const,
        note: unevaluable.join('; '),
      };
    }

    const ruleNow = blockedNow ? (verdict.rule ?? '(unattributed)') : null;
    let outcome: ReplayOutcome;
    if (blockedThen && blockedNow) outcome = ruleNow === row.rule ? 'same' : 'rule-changed';
    else if (blockedThen && !blockedNow) outcome = 'now-allowed';
    else if (!blockedThen && blockedNow) outcome = 'now-blocked';
    else outcome = 'same';

    return { ...base, blockedNow, ruleNow, outcome };
  });
}

export function summarise(results: readonly ReplayResult[]): ReplaySummary {
  const byOutcome: Record<ReplayOutcome, number> = {
    same: 0, 'rule-changed': 0, 'now-allowed': 0, 'now-blocked': 0,
    indeterminate: 0, unreplayable: 0,
  };
  let blockedThen = 0, blockedNow = 0, unreplayable = 0, indeterminate = 0;
  for (const r of results) {
    byOutcome[r.outcome]++;
    if (r.blockedThen) blockedThen++;
    if (r.blockedNow === true) blockedNow++;
    if (r.outcome === 'unreplayable') unreplayable++;
    if (r.outcome === 'indeterminate') indeterminate++;
  }
  return {
    total: results.length,
    replayed: results.length - unreplayable - indeterminate,
    unreplayable,
    indeterminate,
    blockedThen,
    blockedNow,
    byOutcome,
  };
}

/** Display helper: the one-line form of a stored action, redacted, for a terminal. */
export function renderAction(a: ReplayableAction, width = 200): string {
  const r = redactAction(a);
  const raw = r.command !== undefined
    ? `$ ${r.command}`
    : r.filePath !== undefined
      ? `${r.rawTool ?? r.tool ?? 'tool'} ${r.filePath}`
      : `${r.rawTool ?? r.tool ?? r.event}`;
  const one = raw.replace(/\r/g, '').replace(/\n+/g, ' ¶ ').replace(/[ \t]{2,}/g, ' ').trim();
  return one.length <= width ? one : `${one.slice(0, width - 1)}…`;
}

/** Convenience for reports: the directory a stored action was aimed at, for grouping. */
export function actionTargetDir(a: ReplayableAction): string {
  if (a.filePath) return path.dirname(a.filePath);
  return a.cwd || '(unknown)';
}
