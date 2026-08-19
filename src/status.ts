import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentId, ProtectionState } from './types.js';
import type { Store } from './store.js';
import { detectAllScopes } from './install/detect.js';
import { extractUsewardenEntries, integrityHash, nodePath, usewardenScriptPath } from './install/installer.js';
import { planFor, USEWARDEN_TAG } from './install/entries.js';
import { readJsonFile } from './install/jsonfile.js';
import { findRepoRoot, loadPolicy, PolicyLoadError } from './policy/load.js';
import { usewardenHome } from './paths.js';

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
  judge: { calls: number; mocked: number; unmetered: number; usd: number };
  usewardenHome: string;
}

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
  fs.mkdirSync(usewardenHome(), { recursive: true, mode: 0o700 });
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

export function buildStatus(store: Store, cwd: string): StatusReport {
  const unlocked = isUnlocked();
  const recorded = new Map(store.listIntegrity().map((r) => [r.id, r]));
  const bin = usewardenScriptPath();
  const agents: AgentStatus[] = [];

  const repoRoot = findRepoRoot(cwd) ?? undefined;
  const knownPaths = [...recorded.values()].map((r) => r.path);
  for (const d of detectAllScopes(repoRoot, knownPaths)) {
    if (!d.installed) continue;
    const rec = recorded.get(`hook:${d.agent}:${d.scope}:${d.configPath}`);
    const entries = extractUsewardenEntries(d.configPath, d.agent);
    const registered = entries !== null && entries !== '<<unparseable>>';
    const hash = integrityHash(entries);
    const hashMatches = rec ? rec.hash === hash : false;
    const disabled = hooksGloballyDisabled(d.configPath);
    const pointsAtUsewarden = d.agent === 'opencode' ? registered : commandPointsAtUsewarden(entries, bin);

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

    agents.push({
      agent: d.agent, label: d.label, scope: d.scope, configPath: d.configPath,
      installed: d.installed, registered, hashMatches,
      hooksGloballyDisabled: disabled, commandPointsAtUsewarden: pointsAtUsewarden,
      state, detail, ...(d.caveat ? { caveat: d.caveat } : {}),
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
    agents: shown,
    ...(policyError ? { policyError } : {}),
    policySources,
    policyNotices,
    unlocked,
    counters: store.allCounters(),
    checklist: store.checklist().map((c) => ({ step: c.step, done: c.done, label: CHECKLIST_LABELS[c.step] ?? c.step })),
    liveCatches: store.countLiveIncidents(),
    totalCatches: store.countIncidents(),
    judge: { calls: spend.calls, mocked: spend.mocked, unmetered: spend.unmetered, usd: spend.usd },
    usewardenHome: usewardenHome(),
  };
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
