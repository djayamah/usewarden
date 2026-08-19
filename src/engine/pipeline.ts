import type { Incident, NormalizedEvent, Verdict } from '../types.js';
import { ALLOW } from '../types.js';
import type { Store } from '../store.js';
import { loadPolicy, type LoadedPolicy } from '../policy/load.js';
import { currentBranch, describeAttempt, evaluateLayer1 } from './layer1.js';
import { findRepoRoot } from '../policy/load.js';
import { oneLine, redact } from '../util.js';
import { maybeJudge, type JudgeOutcome } from './judge.js';
import { dispatchJudge } from './detached.js';
import { applyInterventions, type InterventionResult } from './interventions.js';

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
  const loaded = opts.loaded ?? loadPolicy(e.cwd);
  const policy = loaded.policy;
  for (const n of loaded.notices) warnings.push(`${n.code}: ${n.detail}`);

  const repoRoot = findRepoRoot(e.cwd) ?? undefined;
  store.upsertSession(e.sessionId, e.agent, e.cwd, e.ts);
  if (e.event === 'session_end') store.endSession(e.sessionId, e.ts);
  if (e.event === 'user_prompt' && e.prompt && !store.getGoal(e.sessionId)) {
    store.setGoal(e.sessionId, redact(e.prompt).slice(0, 2000));
  }

  const target = e.filePath ?? e.command ?? '';
  const fresh = store.recordEvent(e, target);

  const branch = currentBranch(e.cwd);
  const ctx = { policy, ...(branch ? { branch } : {}), ...(repoRoot ? { repoRoot } : {}) };
  const verdict = evaluateLayer1(e, ctx);

  let incidentId: number | undefined;
  const interventions: InterventionResult[] = [];

  if (verdict.severity !== 'info') {
    incidentId = record(store, e, verdict, opts.live);
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
      const jid = record(store, e, judge.verdict, opts.live);
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
export function recordJudgeFinding(store: Store, e: NormalizedEvent, v: Verdict, live: boolean): number {
  return record(store, e, v, live);
}

function record(store: Store, e: NormalizedEvent, v: Verdict, live: boolean): number {
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
    reason: oneLine(v.reason),
    tool: e.rawTool ?? e.tool ?? e.event,
    target: oneLine(redact(e.filePath ?? e.command ?? '')),
    cwd: e.cwd,
  };
  return store.addIncident(inc, live);
}

function titleFor(v: Verdict, e: NormalizedEvent): string {
  if (v.layer === 2) return 'Drift from the declared goal';
  const id = v.rule ?? '';
  if (id.startsWith('scope.forbidden_paths')) return 'Blocked access to protected credentials';
  if (id.startsWith('scope.allowed_paths')) return 'Blocked write outside session scope';
  if (id.startsWith('context.')) return 'Context window filling up';
  const m = /\((.+)\)/.exec(id);
  if (m) return `Blocked command: ${m[1]}`;
  return `Policy violation (${e.tool ?? e.event})`;
}

export { ALLOW };
