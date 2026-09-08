import * as path from 'node:path';
import type { Incident, IncidentOrigin, NormalizedEvent, ReplayableAction, Verdict } from '../types.js';
import { ALLOW } from '../types.js';
import type { Store } from '../store.js';
import { loadPolicy, type LoadedPolicy } from '../policy/load.js';
import { currentBranch, describeAttempt, evaluateLayer1 } from './layer1.js';
import { findRepoRoot } from '../policy/load.js';
import { oneLine, redact } from '../util.js';
import { maybeJudge, type JudgeOutcome } from './judge.js';
import { loadExceptions } from '../exceptions.js';
import { dispatchJudge } from './detached.js';
import { applyInterventions, type InterventionResult } from './interventions.js';
import { maybeAutoBackup } from '../backup.js';

export interface HandleResult {
  verdict: Verdict;
  incidentId?: number;
  /** Non-fatal warnings the adapter should surface (judge down, policy widening refused, ...). */
  warnings: string[];
  interventions: InterventionResult[];
  judge?: JudgeOutcome;
}

export interface HandleOptions {
  /** Marks the incident as originating from a real agent session rather than a fixture. */
  live: boolean;
  /**
   * Finer-grained provenance than `live`, and the axis every reported metric is grouped by.
   * Defaults to `live ? 'live' : 'fixture'`; `usewarden demo` passes 'demo' so its incidents can
   * never reach a headline figure. See src/metrics.ts and docs/METRICS.md.
   */
  origin?: IncidentOrigin;
  /** Pre-loaded policy, so a caller evaluating many events pays the load cost once. */
  loaded?: LoadedPolicy;
  /** Disable the Layer-2 judge for this call regardless of policy (used by tests). */
  noJudge?: boolean;
  /**
   * `inline` awaits the judge (tests, `usewarden judge-run`); `detached` forks it so the hook can
   * answer the agent immediately. Hooks always use `detached` - see engine/detached.ts.
   */
  judgeMode?: 'inline' | 'detached';
}

/**
 * The whole decision path, in the one order the spec fixes: Layer 1 (deterministic, zero token,
 * every event) THEN Layer 2 (sampled LLM). Layer 2 can only add findings; it can never overturn
 * a Layer-1 block, and its unavailability can never disable Layer 1.
 */
export async function handleEvent(
  store: Store,
  e: NormalizedEvent,
  opts: HandleOptions,
): Promise<HandleResult> {
  const warnings: string[] = [];
  const origin: IncidentOrigin = opts.origin ?? (opts.live ? 'live' : 'fixture');
  const loaded = opts.loaded ?? loadPolicy(e.cwd);
  const policy = loaded.policy;
  for (const n of loaded.notices) warnings.push(`${n.code}: ${n.detail}`);

  const repoRoot = findRepoRoot(e.cwd) ?? undefined;
  store.upsertSession(e.sessionId, e.agent, e.cwd, e.ts, origin);
  if (e.event === 'session_end') {
    store.endSession(e.sessionId, e.ts);
    // The record just stopped changing, and this is already a hook usewarden runs — so the copy
    // is refreshed here rather than by anything the user has to schedule or remember. Off unless
    // `backup.dir` is set; throttled by `backup.every_hours`; never throws. See src/backup.ts.
    const note = maybeAutoBackup(policy.backup);
    if (note) warnings.push(note);
  }
  if (e.event === 'user_prompt' && e.prompt && !store.getGoal(e.sessionId)) {
    store.setGoal(e.sessionId, redact(e.prompt).slice(0, 2000));
  }

  const target = e.filePath ?? e.command ?? '';
  // ASKED BEFORE THE EVENT IS RECORDED, on purpose: a moment later this write is in the events
  // table and would answer "yes, the agent already wrote this file" about itself.
  const agentAuthored = e.filePath !== undefined
    && store.sessionHasWrittenTo(e.sessionId, [e.filePath, path.resolve(e.cwd, e.filePath)]);
  const fresh = store.recordEvent(e, target, origin);

  const branch = currentBranch(e.cwd);
  // Read fresh on every event: an exception granted mid-session must take effect on the very next
  // tool call, and one that expires mid-session must stop applying at the same granularity.
  const exceptions = loadExceptions();
  const ctx = {
    policy,
    ...(branch ? { branch } : {}),
    ...(repoRoot ? { repoRoot } : {}),
    ...(agentAuthored ? { agentAuthored } : {}),
    ...(exceptions.length > 0 ? { exceptions } : {}),
  };
  const verdict = evaluateLayer1(e, ctx);

  let incidentId: number | undefined;
  const interventions: InterventionResult[] = [];

  if (verdict.severity !== 'info') {
    incidentId = record(store, e, verdict, opts.live, origin, branch, repoRoot);
    interventions.push(...applyInterventions(verdict, e, policy, repoRoot));
  }

  // --- Layer 2 -----------------------------------------------------------------------
  let judge: JudgeOutcome | undefined;
  const shouldJudge = !opts.noJudge
    && policy.judge.enabled
    && fresh
    && (verdict.severity === 'warn'
      || (e.event === 'pre_tool' && store.sessionEventCount(e.sessionId) % policy.judge.every_n_events === 0)
      || e.event === 'user_prompt');

  if (shouldJudge && opts.judgeMode === 'detached') {
    const file = dispatchJudge({ event: e, layer1: verdict, live: opts.live });
    if (!file) warnings.push('JUDGE_UNAVAILABLE: could not dispatch the drift judge. FAILING OPEN. Layer 1 (deterministic) is still fully active.');
    return {
      verdict,
      ...(incidentId !== undefined ? { incidentId } : {}),
      warnings,
      interventions,
    };
  }

  if (shouldJudge) {
    judge = await maybeJudge(store, e, policy, verdict);
    if (judge.warning) warnings.push(judge.warning);
    if (judge.verdict && judge.verdict.severity !== 'info' && verdict.decision !== 'deny') {
      const jid = record(store, e, judge.verdict, opts.live, origin, branch, repoRoot);
      if (incidentId === undefined) incidentId = jid;
      // Layer 2 never blocks on its own - it warns. Escalating a sampled, fallible, prompt-
      // injectable signal into a hard block is how a guardian becomes unusable.
      return {
        verdict: { ...judge.verdict, decision: 'allow' },
        ...(incidentId !== undefined ? { incidentId } : {}),
        warnings, interventions, judge,
      };
    }
  }

  return {
    verdict,
    ...(incidentId !== undefined ? { incidentId } : {}),
    warnings,
    interventions,
    ...(judge ? { judge } : {}),
  };
}

/** Records a Layer-2 finding produced out of band by the detached judge. */
export function recordJudgeFinding(store: Store, e: NormalizedEvent, v: Verdict, live: boolean, origin?: IncidentOrigin): number {
  return record(store, e, v, live, origin);
}

/**
 * The replay input for an event: the fields Layer 1 actually reads, copied without alteration.
 *
 * `branch` is captured rather than left to be re-derived, because `force-push-protected` asks
 * whether the CURRENT branch is protected and the branch will have moved by replay time. A
 * replay that re-read it from disk would be measuring today's checkout instead of the incident.
 */
export function replayableOf(e: NormalizedEvent, branch?: string, repoRoot?: string): ReplayableAction {
  return {
    agent: e.agent,
    event: e.event,
    cwd: e.cwd,
    ...(repoRoot !== undefined ? { repoRoot } : {}),
    ...(e.tool ? { tool: e.tool } : {}),
    ...(e.rawTool ? { rawTool: e.rawTool } : {}),
    ...(e.command !== undefined ? { command: e.command } : {}),
    ...(e.filePath !== undefined ? { filePath: e.filePath } : {}),
    ...(e.prompt !== undefined ? { prompt: e.prompt } : {}),
    ...(typeof e.contextFill === 'number' ? { contextFill: e.contextFill } : {}),
    ...(branch !== undefined ? { branch } : {}),
  };
}

function record(store: Store, e: NormalizedEvent, v: Verdict, live: boolean, origin?: IncidentOrigin, branch?: string, repoRoot?: string): number {
  const inc: Incident = {
    sessionId: e.sessionId,
    agent: e.agent,
    ts: e.ts,
    layer: v.layer,
    severity: v.severity,
    action: v.severity === 'block' ? 'block' : (v.advice === 'compact-advice' ? 'compact-advice' : 'warn'),
    rule: v.rule ?? '(unattributed)',
    title: titleFor(v, e),
    attempted: redact(describeAttempt(e)),
    // VERBATIM. Not redacted, not one-lined, not truncated - see Incident.replayable and D-277.
    // Redaction of this field happens at every READ path instead; `redactAction()` in
    // src/replay.ts is the single function that does it, so a new display surface added later
    // cannot forget to call it.
    replayable: replayableOf(e, branch, repoRoot),
    reason: oneLine(v.reason),
    tool: e.rawTool ?? e.tool ?? e.event,
    target: oneLine(redact(e.filePath ?? e.command ?? '')),
    cwd: e.cwd,
  };
  return store.addIncident(inc, live, origin);
}

function titleFor(v: Verdict, e: NormalizedEvent): string {
  // FIRST, because every branch below says "Blocked" and a waived action was not blocked.
  // The first version of this checked the waiver LAST, so a card that let a .env read through
  // was titled "Blocked access to protected credentials" - the incident wall claiming a catch it
  // did not make, which is the metrics-inflation failure this project already fixed once (D-069).
  if (v.reason.includes('WAIVED by')) return 'Waived by an explicit human exception';
  if (v.layer === 2) return 'Drift from the declared goal';
  const id = v.rule ?? '';
  if (id.startsWith('scope.forbidden_paths')) return 'Blocked access to protected credentials';
  if (id.startsWith('scope.allowed_paths')) return 'Blocked write outside session scope';
  if (id.startsWith('scope.protect_uncommitted')) return 'Blocked overwrite of work git cannot restore';
  if (id.startsWith('context.')) return 'Context window filling up';
  const m = /\((.+)\)/.exec(id);
  if (m) return `Blocked command: ${m[1]}`;
  return `Policy violation (${e.tool ?? e.event})`;
}

export { ALLOW };
