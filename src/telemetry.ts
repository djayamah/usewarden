import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Store } from './store.js';
import { usewardenHome } from './paths.js';
import { mkdirpSafe, sha256 } from './util.js';
import { buildMetrics } from './metrics.js';

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
 *   - **A recorded consent receipt is required, not just a setting.** See CONSENT below.
 */

/**
 * CONSENT
 * -------
 * "Off by default" is necessary and not sufficient. The failure this guards against is consent
 * drift: a user agrees to send five counters, a later version adds a sixth, and the original
 * yes silently covers something they never read.
 *
 * So the switch is not a boolean. Turning telemetry on writes a RECEIPT naming the schema
 * version and the exact top-level fields consented to, and `telemetryEnabled()` requires a
 * receipt that matches the schema the code would send today. Bump `SCHEMA_VERSION` and every
 * existing consent lapses: telemetry goes off, and stays off, until the user reads the new
 * payload and says yes again. Consent expires by construction rather than by good intentions.
 *
 * A setting flipped directly in the database - `UPDATE meta SET value='on'` - is therefore not
 * enough to make anything leave the machine. Proven by SAB-23.
 */
export const SCHEMA_VERSION = 1;

/** The top-level payload fields a user consents to. Any change here must bump SCHEMA_VERSION. */
export const CONSENTED_FIELDS = ['v', 'usewarden', 'platform', 'node', 'agents', 'counts', 'rules', 'checklist'] as const;

export interface ConsentReceipt {
  granted_at: number;
  schema_version: number;
  usewarden_version: string;
  fields: string[];
  /** Digest of the field list, so a receipt cannot be edited to cover more than it names. */
  digest: string;
}

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

/** Upper bound on how many distinct rule ids may appear, so the map cannot become a channel. */
const MAX_RULE_KEYS = 40;

function consentFile(): string { return path.join(usewardenHome(), 'telemetry', 'consent.json'); }

export function consentDigest(fields: readonly string[], schemaVersion: number): string {
  return sha256(`${schemaVersion}\n${[...fields].sort().join(',')}`);
}

/** Reads the receipt, or null if there is none or it is unreadable/malformed. */
export function readConsent(): ConsentReceipt | null {
  try {
    const raw = JSON.parse(fs.readFileSync(consentFile(), 'utf8')) as ConsentReceipt;
    if (typeof raw?.schema_version !== 'number' || !Array.isArray(raw.fields)) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Is the receipt valid for what this build would send today? A receipt from an older schema, or
 * one whose field list has been edited away from its own digest, is not.
 */
export function consentIsCurrent(r: ConsentReceipt | null): boolean {
  if (!r) return false;
  if (r.schema_version !== SCHEMA_VERSION) return false;
  if (r.digest !== consentDigest(r.fields, r.schema_version)) return false;
  const consented = new Set(r.fields);
  return CONSENTED_FIELDS.every((f) => consented.has(f));
}

export function grantConsent(version: string): ConsentReceipt {
  const fields = [...CONSENTED_FIELDS];
  const receipt: ConsentReceipt = {
    granted_at: Date.now(),
    schema_version: SCHEMA_VERSION,
    usewarden_version: version,
    fields,
    digest: consentDigest(fields, SCHEMA_VERSION),
  };
  mkdirpSafe(path.dirname(consentFile()));
  fs.writeFileSync(consentFile(), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  return receipt;
}

export function revokeConsent(): void {
  try { fs.rmSync(consentFile()); } catch { /* already gone */ }
}

/** Deletes every locally recorded payload. Used by `usewarden telemetry off --purge`. */
export function purgeRecorded(): string | null {
  const f = localFile();
  try { fs.rmSync(f); return f; } catch { return null; }
}

export type OffReason = 'do_not_track' | 'env_override' | 'not_opted_in' | 'consent_lapsed' | null;

/**
 * Why telemetry is off, or null when it is on. Returned alongside the boolean because
 * "consent lapsed after a schema change" and "you never opted in" are different sentences and
 * the user is owed the right one.
 */
export function telemetryOffReason(store: Store): OffReason {
  if (process.env['DO_NOT_TRACK'] === '1') return 'do_not_track';
  if (process.env['USEWARDEN_TELEMETRY'] === '0') return 'env_override';
  if (store.getMeta('telemetry') !== 'on') return 'not_opted_in';
  if (!consentIsCurrent(readConsent())) return 'consent_lapsed';
  return null;
}

export function telemetryEnabled(store: Store): boolean {
  return telemetryOffReason(store) === null;
}

export function explainOffReason(r: OffReason): string {
  switch (r) {
    case 'do_not_track': return 'DO_NOT_TRACK=1 is set and is honoured, overriding any setting.';
    case 'env_override': return 'USEWARDEN_TELEMETRY=0 is set and is honoured, overriding any setting.';
    case 'not_opted_in': return 'You have not opted in. Run "usewarden telemetry on" to see exactly what would be recorded.';
    case 'consent_lapsed': return 'The setting says on, but there is no valid consent receipt for the current payload schema. '
      + 'Consent does not carry across a schema change - re-read the payload and run "usewarden telemetry on" again.';
    default: return 'Telemetry is on.';
  }
}

export function endpoint(): string | null {
  const e = process.env['USEWARDEN_TELEMETRY_ENDPOINT'];
  return e && /^https:\/\//.test(e) ? e : null;
}

/**
 * Builds the payload from DERIVED metrics, not from the raw counter table.
 *
 * This is the same anti-inflation rule the dashboard follows, applied to the wire: a
 * `usewarden demo` run must not be able to move a number that leaves the machine, and a
 * duplicate hook delivery must not be able to double one. Everything here is the live origin.
 * See src/metrics.ts and docs/METRICS.md.
 */
export function buildPayload(store: Store, version: string, agents: string[], checklist: string[]): TelemetryPayload {
  const m = buildMetrics(store);
  const rules: Record<string, number> = {};
  for (const row of store.incidentsByOrigin('live', 500)) {
    // Only the rule ID inside the parentheses, or the bare dotted policy key. Never the target.
    const match = /\(([a-z0-9-]+)\)\s*$/.exec(row.rule);
    const id = match ? match[1]! : row.rule.split('[')[0]!.trim();
    if (!isSafeLabel(id)) continue;
    if (rules[id] === undefined && Object.keys(rules).length >= MAX_RULE_KEYS) continue;
    rules[id] = (rules[id] ?? 0) + 1;
  }
  return {
    v: 1,
    usewarden: version,
    platform: process.platform,
    node: process.versions.node.split('.')[0]!,
    agents: [...agents].sort(),
    counts: {
      events_seen: m.live.events,
      actions_blocked: m.live.attempts,
      drift_caught: m.live.drift_warnings,
      sessions: m.live.sessions,
      live_catches: m.live.incidents,
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

function localFile(): string { return path.join(usewardenHome(), 'telemetry', 'local.jsonl'); }

/** Records the payload locally, always. This is the whole of v1. */
export function record(store: Store, payload: TelemetryPayload): string {
  const dir = path.join(usewardenHome(), 'telemetry');
  mkdirpSafe(dir);
  const file = localFile();
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
