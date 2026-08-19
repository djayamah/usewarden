import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Store } from './store.js';
import { usewardenHome } from './paths.js';

/**
 * Telemetry (spec section 3C, docs/THREAT-MODEL.md T-15, schema in docs/TELEMETRY.md).
 *
 * v1 ships the LOCAL RECORDER AND THE SCHEMA ONLY. There is no endpoint, and `endpoint()`
 * returns null unless the user sets one themselves. Nothing leaves the machine.
 *
 * Non-negotiables, each with a test:
 *   - OFF by default. Requires an explicit `usewarden telemetry on`.
 *   - `USEWARDEN_TELEMETRY=0` and `DO_NOT_TRACK=1` both force it off, overriding the setting.
 *   - 2-second hard timeout, ZERO retries, fire-and-forget, `unref`'d. The documented failure
 *     mode of common analytics SDKs is retry-with-backoff, which hangs a CLI on a firewalled or
 *     offline machine. Usewarden must never be the reason a hook does not return.
 *   - Counts and coarse categories only. Never a path, a prompt, a command, a file's contents,
 *     a hostname, or a username. `buildPayload` is a pure function so a test can assert the
 *     whole payload field by field.
 */

export interface TelemetryPayload {
  /** Schema version, so a future field addition is detectable rather than silent. */
  v: 1;
  /** Usewarden's version. */
  usewarden: string;
  /** Coarse platform only: 'darwin' | 'linux' | 'win32'. No release, no arch, no hostname. */
  platform: string;
  /** Major Node version only, e.g. "22". */
  node: string;
  /** Which agents are registered, as a sorted id list. No paths. */
  agents: string[];
  /** Whole-number counters. */
  counts: {
    events_seen: number;
    actions_blocked: number;
    drift_caught: number;
    sessions: number;
    live_catches: number;
  };
  /** Which rule IDS fired, and how often. Rule ids are usewarden's own vocabulary, never user data. */
  rules: Record<string, number>;
  /** Coarse install-funnel state. */
  checklist: string[];
}

const DENY_SUBSTRINGS = ['/', '\\', '@', 'sk-', 'ghp_', 'http'];

export function telemetryEnabled(store: Store): boolean {
  if (process.env['DO_NOT_TRACK'] === '1') return false;
  if (process.env['USEWARDEN_TELEMETRY'] === '0') return false;
  return store.getMeta('telemetry') === 'on';
}

export function endpoint(): string | null {
  const e = process.env['USEWARDEN_TELEMETRY_ENDPOINT'];
  return e && /^https:\/\//.test(e) ? e : null;
}

export function buildPayload(store: Store, version: string, agents: string[], checklist: string[]): TelemetryPayload {
  const counters = store.allCounters();
  const rules: Record<string, number> = {};
  for (const row of store.recentIncidents(500)) {
    // Only the rule ID inside the parentheses, or the bare dotted policy key. Never the target.
    const m = /\(([a-z0-9-]+)\)\s*$/.exec(row.rule);
    const id = m ? m[1]! : row.rule.split('[')[0]!.trim();
    if (!isSafeLabel(id)) continue;
    rules[id] = (rules[id] ?? 0) + 1;
  }
  return {
    v: 1,
    usewarden: version,
    platform: process.platform,
    node: process.versions.node.split('.')[0]!,
    agents: [...agents].sort(),
    counts: {
      events_seen: counters['events_seen'] ?? 0,
      actions_blocked: counters['actions_blocked'] ?? 0,
      drift_caught: counters['drift_caught'] ?? 0,
      sessions: store.countSessions(),
      live_catches: store.countLiveIncidents(),
    },
    rules,
    checklist: [...checklist].sort(),
  };
}

/** A label is only allowed through if it cannot possibly be user data. */
export function isSafeLabel(s: string): boolean {
  if (s.length === 0 || s.length > 48) return false;
  if (!/^[a-z0-9_.-]+$/.test(s)) return false;
  return !DENY_SUBSTRINGS.some((d) => s.includes(d));
}

/** Records the payload locally, always. This is the whole of v1. */
export function record(store: Store, payload: TelemetryPayload): string {
  const dir = path.join(usewardenHome(), 'telemetry');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'local.jsonl');
  fs.appendFileSync(file, JSON.stringify(payload) + '\n', { mode: 0o600 });
  return file;
}

/**
 * Fire-and-forget send. Returns immediately; the caller never awaits it.
 * If no endpoint is configured (the v1 default) this does nothing at all.
 */
export function send(payload: TelemetryPayload): void {
  const url = endpoint();
  if (!url) return;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 2000);
  // unref so a pending timer can never hold the process open (spec 3C).
  timer.unref?.();
  void fetch(url, {
    method: 'POST',
    signal: ac.signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: false,
  }).catch(() => { /* zero retries, by design */ })
    .finally(() => clearTimeout(timer));
}
