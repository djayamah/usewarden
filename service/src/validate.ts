/**
 * Strict validation for an inbound telemetry payload.
 *
 * This runs on the SERVER, and it does not trust the client at all - not even usewarden's own
 * client. The threat is not one hostile submitter; it is that a receiving endpoint quietly
 * becomes a channel for the thing the whole product promises never to send. So the server
 * re-derives every guarantee `docs/TELEMETRY.md` makes rather than assuming the sender honoured
 * it:
 *
 *   - the payload must have EXACTLY the documented keys. Not "at least" - exactly. An unknown
 *     key is a rejection, never an ignored extra;
 *   - every string is re-checked against a content gate as well as a schema. Adding a field to
 *     the schema without thinking therefore cannot open a channel by itself;
 *   - the counts must be arithmetically possible. A submission claiming more blocked actions
 *     than inspected events is the exact inflation defect usewarden fixed in its own client
 *     (docs/METRICS.md section 1), and it is refused here too - a server that accepts impossible
 *     numbers will eventually publish them.
 *
 * Nothing in this file writes, logs, or returns anything derived from the payload's content
 * beyond a fixed reason code.
 */

export const MAX_BODY_BYTES = 8 * 1024;
export const MAX_RULE_KEYS = 40;
export const MAX_COUNT = 10_000_000;
export const MAX_RULE_COUNT = 1_000_000;

const TOP_LEVEL_KEYS = ['v', 'usewarden', 'platform', 'node', 'agents', 'counts', 'rules', 'checklist'] as const;
const COUNT_KEYS = ['events_seen', 'actions_blocked', 'drift_caught', 'sessions', 'live_catches'] as const;
const PLATFORMS = new Set(['darwin', 'linux', 'win32', 'freebsd', 'openbsd', 'aix', 'sunos']);
const AGENTS = new Set(['claude', 'cursor', 'gemini', 'copilot', 'codex', 'opencode']);
const CHECKLIST = new Set(['agents_detected', 'policy_created', 'protection_verified', 'first_catch']);

export interface ValidPayload {
  v: 1;
  usewarden: string;
  platform: string;
  node: string;
  agents: string[];
  counts: Record<(typeof COUNT_KEYS)[number], number>;
  rules: Record<string, number>;
  checklist: string[];
}

export type Rejection = { ok: false; reason: string };
export type Acceptance = { ok: true; payload: ValidPayload };
export type Result = Acceptance | Rejection;

const reject = (reason: string): Rejection => ({ ok: false, reason });

/**
 * The content gate. Independent of the schema on purpose: a string that survives the schema must
 * ALSO be unable to carry a path, an address, a URL, a credential, or free text.
 */
export function looksLikeUserData(s: string): boolean {
  if (s.length > 64) return true;
  if (/[\s/\\@]/.test(s)) return true;
  // `AQ\.` is Google's current Gemini key prefix; `AIza` is the legacy one. Both are live in the
  // wild at once, and Google publishes no format spec - see src/util.ts.
  if (/sk-|ghp_|github_pat_|npm_|xox[baprs]-|AKIA|AIza|AQ\.[A-Za-z0-9_-]{20,}|BEGIN .*PRIVATE KEY/.test(s)) return true;
  if (/https?:/i.test(s)) return true;
  return false;
}

export function isSafeLabel(s: string): boolean {
  return s.length > 0 && s.length <= 48 && /^[a-z0-9_.-]+$/.test(s) && !looksLikeUserData(s);
}

function isWholeNumber(x: unknown, max: number): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= max;
}

function exactKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  const got = Object.keys(o).sort();
  const want = [...keys].sort();
  return got.length === want.length && got.every((k, i) => k === want[i]);
}

export function validate(raw: unknown): Result {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return reject('not_an_object');
  const p = raw as Record<string, unknown>;

  if (!exactKeys(p, TOP_LEVEL_KEYS)) return reject('unknown_or_missing_top_level_key');
  if (p['v'] !== 1) return reject('unsupported_schema_version');

  if (typeof p['usewarden'] !== 'string' || !/^\d{1,3}\.\d{1,3}\.\d{1,3}(-[a-z0-9.]{1,16})?$/.test(p['usewarden'])) {
    return reject('bad_version');
  }
  if (typeof p['platform'] !== 'string' || !PLATFORMS.has(p['platform'])) return reject('bad_platform');
  if (typeof p['node'] !== 'string' || !/^\d{1,3}$/.test(p['node'])) return reject('bad_node');

  const agents = p['agents'];
  if (!Array.isArray(agents) || agents.length > AGENTS.size) return reject('bad_agents');
  for (const a of agents) {
    if (typeof a !== 'string' || !AGENTS.has(a)) return reject('bad_agents');
  }
  if (new Set(agents).size !== agents.length) return reject('duplicate_agents');

  const counts = p['counts'];
  if (typeof counts !== 'object' || counts === null || Array.isArray(counts)) return reject('bad_counts');
  const c = counts as Record<string, unknown>;
  if (!exactKeys(c, COUNT_KEYS)) return reject('unknown_or_missing_count_key');
  for (const k of COUNT_KEYS) {
    if (!isWholeNumber(c[k], MAX_COUNT)) return reject('bad_count_value');
  }
  const seen = c['events_seen'] as number;
  for (const k of ['actions_blocked', 'drift_caught', 'live_catches', 'sessions'] as const) {
    // usewarden cannot block, judge, or session what it never inspected. A submission claiming
    // otherwise is either broken or inflated; either way it is not evidence of anything.
    if ((c[k] as number) > seen) return reject('inconsistent_counts');
  }

  const rules = p['rules'];
  if (typeof rules !== 'object' || rules === null || Array.isArray(rules)) return reject('bad_rules');
  const r = rules as Record<string, unknown>;
  const ruleKeys = Object.keys(r);
  if (ruleKeys.length > MAX_RULE_KEYS) return reject('too_many_rule_keys');
  let ruleTotal = 0;
  for (const k of ruleKeys) {
    if (!isSafeLabel(k)) return reject('unsafe_rule_label');
    if (!isWholeNumber(r[k], MAX_RULE_COUNT)) return reject('bad_rule_value');
    ruleTotal += r[k] as number;
  }
  if (ruleTotal > seen) return reject('inconsistent_counts');

  const checklist = p['checklist'];
  if (!Array.isArray(checklist) || checklist.length > CHECKLIST.size) return reject('bad_checklist');
  for (const step of checklist) {
    if (typeof step !== 'string' || !CHECKLIST.has(step)) return reject('bad_checklist');
  }
  if (new Set(checklist).size !== checklist.length) return reject('duplicate_checklist');

  // Belt and braces: every string anywhere in the payload, re-checked for content.
  for (const s of allStrings(p)) {
    if (looksLikeUserData(s)) return reject('string_looks_like_user_data');
  }

  return { ok: true, payload: p as unknown as ValidPayload };
}

function* allStrings(v: unknown): Generator<string> {
  if (typeof v === 'string') { yield v; return; }
  if (Array.isArray(v)) { for (const x of v) yield* allStrings(x); return; }
  if (typeof v === 'object' && v !== null) {
    for (const [k, x] of Object.entries(v)) { yield k; yield* allStrings(x); }
  }
}
