import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentId, ProtectionState } from './types.js';
import type { Store } from './store.js';
import { buildMetrics, type Metrics } from './metrics.js';
import { detectAllScopes } from './install/detect.js';
import { extractUsewardenEntries, extractUsewardenEntriesLegacy, integrityHash, nodePath, usewardenScriptPath } from './install/installer.js';
import { planFor, USEWARDEN_TAG } from './install/entries.js';
import { readJsonFile } from './install/jsonfile.js';
import { findRepoRoot, loadPolicy, PolicyLoadError } from './policy/load.js';
import { usewardenHome } from './paths.js';
import { compareToSeal, readSeal, sealPolicy, type DriftReport } from './policy/drift.js';
import { mkdirpSafe } from './util.js';

/**
 * `usewarden status` - the loudest surface in the product.
 *
 * Spec section 3B: "A guardian that silently isn't running is this product's worst failure
 * mode." Everything here is written so the failure states are LOUD and DISTINCT:
 *
 *   PROTECTED      usewarden's entries are present, unmodified, and point at usewarden's own binary
 *   UNPROTECTED    entries missing, or the agent has hooks globally disabled  (RED)
 *   TAMPERED       entries present but changed from the recorded hash        (RED)
 *   POLICY_INVALID usewarden.yaml does not parse or does not validate           (RED)
 *
 * The escape hatch (THREAT-MODEL T-08) suppresses TAMPERED, never UNPROTECTED: a user who is
 * legitimately editing their agent config gets out of usewarden's way, but a user whose protection
 * has actually been removed is always told.
 */

export interface AgentStatus {
  agent: AgentId;
  label: string;
  scope: string;
  configPath: string;
  installed: boolean;
  registered: boolean;
  hashMatches: boolean;
  hooksGloballyDisabled: boolean;
  commandPointsAtUsewarden: boolean;
  state: ProtectionState;
  caveat?: string;
  detail: string;
  /**
   * EVIDENCE THAT THE HOOK EXECUTES, as opposed to evidence that it is written down.
   *
   * Every other field above is derived from reading a config file. None of them can distinguish a
   * hook that fires from one that is spawned and fails - which is the defect in
   * writeups/01-hook-not-running, where `status` said PROTECTED, correctly by its own logic, while
   * every invocation died with EACCES and the agent carried on.
   *
   * `verdict` is deliberately three-valued, per CLAUDE.md §4.4: "I could not tell" and "it is
   * fine" are different sentences.
   *
   *   firing      events have arrived from this agent since it was registered
   *   pending     registered within the grace window and nothing has come in yet - normal
   *   unverified  registered longer ago than that, still nothing. EITHER the agent has not been
   *               used, OR its hooks are not executing. Usewarden cannot tell these apart, and
   *               says so rather than reporting protection it has not observed.
   */
  firing: {
    verdict: 'firing' | 'pending' | 'unverified';
    events: number;
    lastEventTs: number | null;
    registeredAt: number | null;
  };
}

/**
 * How long a freshly registered agent may stay silent before usewarden stops calling it verified.
 *
 * 24 hours, and the number is a trade rather than a truth. Shorter and every `usewarden init`
 * is followed by an alarm about an agent the user simply has not opened yet; longer and a
 * genuinely dead hook looks healthy for a working week. A false alarm is how a security tool
 * teaches people to ignore it - the same reasoning as `looksLikeUsewardenScript` below.
 */
export const FIRING_GRACE_MS = 24 * 60 * 60 * 1000;

/** One row of `usewarden doctor`. `unverified` is the third outcome — see `firingFinding`. */
export interface DoctorFinding { check: string; ok: boolean; detail: string; unverified?: boolean }

/** "3 days ago", for a doctor row that has to be readable at a glance. */
export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/**
 * The firing row for one agent: the only check in `usewarden doctor` that is evidence of
 * EXECUTION rather than of bookkeeping.
 *
 * It lives here, beside `AgentStatus`, and not in cli.ts, because cli.ts calls `main()` at module
 * scope — importing it to test one pure function runs the whole CLI as a side effect and sets
 * `process.exitCode`. A test that has to boot the program to check a string is a test that will
 * eventually fail for a reason unrelated to what it asserts.
 */
export function firingFinding(a: { label: string; firing: AgentStatus['firing'] }, now = Date.now()): DoctorFinding {
  const f = a.firing;
  const check = `${a.label}: hooks have actually fired`;
  if (f.verdict === 'firing') {
    return { check, ok: true, detail: `${f.events} event${f.events === 1 ? '' : 's'} recorded, last ${ago(f.lastEventTs!, now)}` };
  }
  if (f.verdict === 'pending') {
    return { check, ok: true, detail: `registered ${ago(f.registeredAt!, now)}, no events yet - that is normal this soon after "usewarden init"` };
  }
  return {
    check, ok: false, unverified: true,
    detail: f.registeredAt === null
      ? 'no events from this agent, and no record of when it was registered'
      : `NO EVENTS EVER, registered ${ago(f.registeredAt, now)}. Either you have not used this agent since then, `
        + 'or its hooks are registered and not executing. Usewarden cannot tell those apart from here: '
        + 'run any command in that agent and re-run "usewarden doctor".',
  };
}

export interface StatusReport {
  overall: ProtectionState;
  agents: AgentStatus[];
  policyError?: string;
  policySources: string[];
  policyNotices: string[];
  unlocked: boolean;
  counters: Record<string, number>;
  checklist: { step: string; done: boolean; label: string }[];
  liveCatches: number;
  totalCatches: number;
  /**
   * Every reported number, derived per origin. `counters` above is the RAW monotonic ledger and
   * is kept only for debugging - reading a headline figure from it is what produced the
   * inflation recorded in verification/metrics-inflation-before.txt. See src/metrics.ts.
   */
  metrics: Metrics;
  judge: { calls: number; mocked: number; unmetered: number; usd: number };
  usewardenHome: string;
  /**
   * Has the policy become weaker than the one this machine was installed with?
   *
   * A separate question from every other field here, all of which are about the AGENTS' hook
   * registrations. Those were all green on 2026-08-29 while usewarden's own rules were being
   * narrowed by an agent's `sed`. See src/policy/drift.ts.
   */
  drift: DriftReport;
}

/** How much evidence `buildStatus` should spend on the drift comparison. */
export type DriftDepth = 'off' | 'probes' | 'full';

const CHECKLIST_LABELS: Record<string, string> = {
  agents_detected: 'Agents detected',
  policy_created: 'Policy created',
  protection_verified: 'Protection verified',
  first_catch: 'First catch in a real session',
};

function unlockFile(): string { return path.join(usewardenHome(), 'unlock'); }

/** `usewarden unlock` grants a 15-minute window in which config edits do not raise TAMPERED. */
export function unlock(minutes = 15): number {
  const until = Date.now() + minutes * 60_000;
  mkdirpSafe(usewardenHome());
  fs.writeFileSync(unlockFile(), String(until), { mode: 0o600 });
  return until;
}

export function relock(): void {
  try { fs.rmSync(unlockFile()); } catch { /* already locked */ }
}

export function isUnlocked(): boolean {
  if (process.env['USEWARDEN_ALLOW_CONFIG_WRITE'] === '1') return true;
  try {
    const until = Number(fs.readFileSync(unlockFile(), 'utf8').trim());
    return Number.isFinite(until) && Date.now() < until;
  } catch {
    return false;
  }
}

export function buildStatus(store: Store, cwd: string, depth: DriftDepth = 'full'): StatusReport {
  const unlocked = isUnlocked();
  const recorded = new Map(store.listIntegrity().map((r) => [r.id, r]));
  const bin = usewardenScriptPath();
  const agents: AgentStatus[] = [];
  const firingByAgent = store.eventStatsByAgent();
  const now = Date.now();

  const repoRoot = findRepoRoot(cwd) ?? undefined;
  const knownPaths = [...recorded.values()].map((r) => r.path);
  for (const d of detectAllScopes(repoRoot, knownPaths)) {
    if (!d.installed) continue;
    const rec = recorded.get(`hook:${d.agent}:${d.scope}:${d.configPath}`);
    const entries = extractUsewardenEntries(d.configPath, d.agent);
    const registered = entries !== null && entries !== '<<unparseable>>';
    const hash = integrityHash(entries);
    // A stored hash from before D-243 included the `_usewarden` tag. Accept it once, then write
    // the new form back so the migration happens silently and exactly once per config.
    let hashMatches = rec ? rec.hash === hash : false;
    if (rec && !hashMatches) {
      const legacy = integrityHash(extractUsewardenEntriesLegacy(d.configPath, d.agent));
      if (rec.hash === legacy) {
        hashMatches = true;
        store.putIntegrity({ ...rec, hash, recordedAt: Date.now() });
      }
    }
    const disabled = hooksGloballyDisabled(d.configPath);
    const pointsAtUsewarden = d.agent === 'opencode' ? registered : commandPointsAtUsewarden(entries, bin);
    // Registered paths that are not on disk. Only meaningful when the command does not match:
    // it separates "usewarden moved" from "someone swapped the payload".
    // A stale path is only treated as benign when it POSITIVELY LOOKS LIKE a usewarden install
    // that has gone away - same script filename, and a `usewarden` directory segment on the way
    // to it. `/tmp/evil-payload.js` does not qualify and stays TAMPERED.
    //
    // This discriminator is the whole reason the softer message is safe to show. Without it the
    // rule would read "any path that does not exist is benign", which hands an attacker a way to
    // downgrade the alarm by pointing the entry somewhere they have not created yet.
    const staleScripts = pointsAtUsewarden
      ? []
      : registeredScriptPaths(entries).filter((p) => !fs.existsSync(p) && looksLikeUsewardenScript(p, bin));

    let state: ProtectionState;
    let detail: string;
    if (!rec) {
      state = 'UNPROTECTED';
      detail = 'usewarden has never registered hooks for this agent. Run: usewarden init';
    } else if (!registered) {
      state = 'UNPROTECTED';
      detail = `usewarden's hook entries are GONE from ${d.configPath}. Usewarden is not watching this agent. Run: usewarden init`;
    } else if (disabled) {
      state = 'UNPROTECTED';
      detail = `"disableAllHooks": true is set in ${d.configPath}. Every hook, including usewarden's, is switched off.`;
    } else if (!pointsAtUsewarden && staleScripts.length > 0) {
      // The registered file is not on disk. Nothing is executing, so nothing was substituted -
      // usewarden moved. UNPROTECTED is the accurate state and re-registering is the whole fix.
      state = 'UNPROTECTED';
      detail = `usewarden is registered in ${d.configPath} at ${staleScripts[0]}, which no longer `
        + 'exists - usewarden was moved, reinstalled, or its node_modules was deleted. The hook '
        + 'cannot run, so you are NOT protected. Run: usewarden init';
    } else if (!pointsAtUsewarden) {
      state = 'TAMPERED';
      detail = `a hook entry tagged as usewarden's does NOT invoke ${bin}. Something rewrote it. Inspect ${d.configPath} immediately.`;
    } else if (!hashMatches) {
      state = unlocked ? 'PROTECTED' : 'TAMPERED';
      detail = unlocked
        ? `entries changed since the last baseline, but usewarden is UNLOCKED so this is treated as your own edit. Re-baseline with: usewarden init`
        : `usewarden's hook entries in ${d.configPath} do not match the recorded hash. If you changed them yourself, run "usewarden unlock" (or set USEWARDEN_ALLOW_CONFIG_WRITE=1) and then "usewarden init" to re-baseline.`;
    } else {
      state = 'PROTECTED';
      detail = 'hooks registered and unmodified';
    }

    // Has this agent ever actually delivered an event? Asked per agent rather than globally,
    // because the interesting case is precisely the one a global count hides: Claude Code
    // firing hundreds of times while Codex CLI, registered on the same day, has never fired once.
    const seen = firingByAgent.get(d.agent);
    const registeredAt = rec?.recordedAt ?? null;
    const firing: AgentStatus['firing'] = {
      verdict: seen && seen.count > 0 ? 'firing'
        : registeredAt !== null && now - registeredAt < FIRING_GRACE_MS ? 'pending'
          : 'unverified',
      events: seen?.count ?? 0,
      lastEventTs: seen?.lastTs ?? null,
      registeredAt,
    };

    agents.push({
      agent: d.agent, label: d.label, scope: d.scope, configPath: d.configPath,
      installed: d.installed, registered, hashMatches,
      hooksGloballyDisabled: disabled, commandPointsAtUsewarden: pointsAtUsewarden,
      state, detail, firing, ...(d.caveat ? { caveat: d.caveat } : {}),
    });
  }

  let policyError: string | undefined;
  let policySources: string[] = [];
  let policyNotices: string[] = [];
  try {
    const loaded = loadPolicy(cwd);
    policySources = loaded.sources;
    policyNotices = loaded.notices.map((n) => `${n.code}: ${n.detail}`);
  } catch (e) {
    policyError = e instanceof PolicyLoadError ? e.message : (e as Error).message;
  }

  /**
   * Aggregate PER AGENT, not per config file. An agent watched at the project layer IS watched,
   * even though its user layer was never registered - reporting that as UNPROTECTED would be a
   * false alarm, and a guardian that cries wolf gets ignored (which is the same failure as not
   * running at all). TAMPERED still wins over PROTECTED at any layer: an entry that claims to be
   * usewarden's but is not needs looking at whatever else is healthy.
   */
  const byAgent = new Map<AgentId, ProtectionState>();
  for (const a of agents) {
    const cur = byAgent.get(a.agent);
    if (a.state === 'TAMPERED' || cur === 'TAMPERED') byAgent.set(a.agent, 'TAMPERED');
    else if (a.state === 'PROTECTED' || cur === 'PROTECTED') byAgent.set(a.agent, 'PROTECTED');
    else byAgent.set(a.agent, 'UNPROTECTED');
  }
  // Hide a never-registered user layer for an agent that IS protected at another layer.
  const shown = agents.filter((a) => !(a.state === 'UNPROTECTED' && !a.registered
    && byAgent.get(a.agent) === 'PROTECTED'));

  const states = [...byAgent.values()];
  let overall: ProtectionState;
  if (policyError) overall = 'POLICY_INVALID';
  else if (states.length === 0) overall = 'UNPROTECTED';
  else if (states.includes('TAMPERED')) overall = 'TAMPERED';
  else if (states.includes('UNPROTECTED')) overall = 'UNPROTECTED';
  else overall = 'PROTECTED';

  if (overall === 'PROTECTED') store.completeStep('protection_verified', Date.now());
  if (agents.length > 0) store.completeStep('agents_detected', Date.now());

  const spend = store.totalJudgeSpend();
  return {
    overall,
    drift: driftFor(store, repoRoot ?? cwd, depth),
    agents: shown,
    ...(policyError ? { policyError } : {}),
    policySources,
    policyNotices,
    unlocked,
    counters: store.allCounters(),
    checklist: store.checklist().map((c) => ({ step: c.step, done: c.done, label: CHECKLIST_LABELS[c.step] ?? c.step })),
    liveCatches: store.countLiveIncidents(),
    totalCatches: store.countIncidents(),
    metrics: buildMetrics(store),
    judge: { calls: spend.calls, mocked: spend.mocked, unmetered: spend.unmetered, usd: spend.usd },
    usewardenHome: usewardenHome(),
  };
}

/**
 * The drift comparison, at the depth the calling surface can afford.
 *
 * `full` replays the recorded corpus as well as the synthetic probes, and is what `status` and
 * `doctor` use. `probes` skips the corpus, which is the only part that grows with history, and is
 * what the status line uses — it runs on every prompt and a check that costs milliseconds there is
 * a check the user turns off. `off` is for callers that only want registration state.
 *
 * SEALING ON FIRST SIGHT. A machine with a policy and no seal is an upgrade from a version that
 * had none, and there is nothing to compare against. Usewarden seals what it finds, marked
 * `first-observed`, and the report says exactly that — the seal proves nothing about the days
 * before it was written, and describing it as a clean bill of health would be the same
 * looks-like-a-backup failure that `docs/BACKUP.md` exists to prevent.
 */
function driftFor(store: Store, base: string, depth: DriftDepth): DriftReport {
  const emptyReport: DriftReport = {
    seal: null, currentHash: null, changed: false,
    lostProbes: [], gainedProbes: [], downgradedProbes: [], lostCatches: [], corpusConsidered: 0,
    unavailable: 'not checked',
  };
  if (depth === 'off') return emptyReport;
  try {
    if (readSeal() === null) sealPolicy('first-observed');
    const rows = depth === 'full' ? store.replayCorpus('live') : [];
    return compareToSeal({ base, rows });
  } catch (e) {
    return { ...emptyReport, unavailable: `could not compare: ${(e as Error).message}` };
  }
}

function hooksGloballyDisabled(configPath: string): boolean {
  try {
    const f = readJsonFile(configPath);
    return f.value['disableAllHooks'] === true
      || (typeof f.value['hooks'] === 'object' && f.value['hooks'] !== null
        && (f.value['hooks'] as Record<string, unknown>)['disableAllHooks'] === true);
  } catch {
    return false;
  }
}

/**
 * Walks the extracted usewarden subtree and asserts every command really is usewarden's own binary.
 * This is the check that catches the nastiest tamper: an attacker keeps the `_usewarden: true` tag
 * (so the entry still looks like ours) but swaps the command for their own payload.
 */
/**
 * The script paths the REGISTERED entries actually invoke, whatever they are.
 *
 * Needed to tell two very different situations apart. Both make `commandPointsAtUsewarden`
 * false, and before this they produced the same alarming message:
 *
 *   - the registered path DOES NOT EXIST. usewarden moved: a local `node_modules` install was
 *     replaced by a global one, or `node_modules` was deleted, or the project directory was.
 *     Nothing rewrote anything and nothing is executing. The user is UNPROTECTED and the fix is
 *     one command.
 *   - the registered path EXISTS and is something else. That is the nasty tamper this check was
 *     written for - an attacker keeping the `_usewarden: true` tag and swapping the payload.
 *
 * Telling a user who ran `npm install -g usewarden` that "something rewrote it, inspect
 * immediately" is a false alarm, and false alarms are how a security tool teaches people to
 * ignore it.
 */
/**
 * Does this path look like a usewarden CLI that is simply not there any more?
 *
 * Same script filename as our own, and a path segment literally named `usewarden` - which every
 * npm install layout produces, local (`node_modules/usewarden/dist/src/cli.js`) and global
 * (`lib/node_modules/usewarden/dist/src/cli.js`) alike. Deliberately strict: this is what decides
 * whether a mismatch is reported as "it moved" or as "someone rewrote it", and the cost of being
 * wrong in the lenient direction is a muted alarm.
 */
function looksLikeUsewardenScript(candidate: string, ownScript: string): boolean {
  if (path.basename(candidate) !== path.basename(ownScript)) return false;
  return candidate.split(path.sep).includes('usewarden');
}

function registeredScriptPaths(entries: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (typeof v !== 'object' || v === null) return;
    const o = v as Record<string, unknown>;
    if (typeof o['command'] === 'string') {
      const args = Array.isArray(o['args']) ? o['args'] as unknown[] : null;
      if (args && typeof args[0] === 'string') {
        out.push(args[0]);
      } else {
        // Command-string form (Cursor): '<node>' '<script>' hook ...
        const m = /^'[^']*'\s+'([^']*)'/.exec(o['command']);
        if (m?.[1]) out.push(m[1]);
      }
    }
    for (const val of Object.values(o)) visit(val);
  };
  visit(entries);
  return [...new Set(out)];
}

function commandPointsAtUsewarden(entries: unknown, script: string): boolean {
  const node = nodePath();
  let sawCommand = false;
  let allOk = true;
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (typeof v !== 'object' || v === null) return;
    const o = v as Record<string, unknown>;
    if (typeof o['command'] === 'string') {
      sawCommand = true;
      const c = o['command'];
      const args = Array.isArray(o['args']) ? o['args'] as unknown[] : null;
      if (args) {
        // argv form: command must be the node binary and argv[0] usewarden's own script.
        if (!(c === node && args[0] === script && args[1] === 'hook')) allOk = false;
      } else {
        // Command-string form (Cursor): must be the quoted node + quoted script + fixed argv.
        const expected = `'${node}' '${script}' hook `;
        if (!c.startsWith(expected)) allOk = false;
      }
    }
    for (const val of Object.values(o)) visit(val);
  };
  visit(entries);
  return sawCommand && allOk;
}

/** Used by the sabotage tests and by `usewarden doctor` to prove the tag is what we think it is. */
export const USEWARDEN_ENTRY_TAG = USEWARDEN_TAG;
export { planFor };
