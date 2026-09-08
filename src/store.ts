import './boot.js';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType, StatementSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentId, CanonicalTool, EventKind, Incident, IncidentOrigin, IntegrityRecord,
  NormalizedEvent, ReplayableAction } from './types.js';
import { dbPath, ensureHome } from './paths.js';
import { mkdirpSafe, sha256 } from './util.js';

/**
 * `node:sqlite` is loaded through createRequire rather than a static ESM import.
 *
 * This is NOT stylistic. On some Node versions loading node:sqlite prints
 * `ExperimentalWarning: SQLite is an experimental feature` to stderr, and ESM resolves and
 * loads every static import BEFORE any user module body runs - so `boot.ts` could never win
 * that race with a static import here. A deferred require runs after boot.ts has removed the
 * warning listener. Measured: with a static import the warning leaks into hook stderr on
 * v25.5.0; with this, stderr is empty. See DECISIONS.md D-003 and THREAT-MODEL T-11.
 */
type SqliteModule = { DatabaseSync: new (path: string, options?: unknown) => DatabaseSyncType };
let sqlite: SqliteModule | undefined;
function loadSqlite(): SqliteModule {
  if (!sqlite) sqlite = createRequire(import.meta.url)('node:sqlite') as SqliteModule;
  return sqlite;
}

/**
 * Where a replay input came from. `unavailable` is a FAILURE that is counted, not a row that
 * quietly disappears - CLAUDE.md §4.4: "a control whose state could not be checked is reported
 * as UNVERIFIED and counted against the total".
 */
export type ReplayProvenance = 'stored' | 'recovered' | 'unavailable';

export interface ReplayRow {
  id: number;
  sessionId: string;
  agent: AgentId;
  ts: number;
  layer: number;
  severity: string;
  /** What usewarden DID: 'block' | 'warn' | ... */
  action: string;
  rule: string;
  title: string;
  /** The lossy display rendering. Kept so a reader can see what the card said. */
  attempted: string;
  reason: string;
  tool: string;
  target: string;
  cwd: string;
  origin: IncidentOrigin;
  provenance: ReplayProvenance;
  /** Why the input is unavailable, when it is. Empty otherwise. */
  unavailableReason?: string;
  replayable?: ReplayableAction;
}

const CANONICAL_TOOLS = new Set<string>([
  'bash', 'read', 'write', 'edit', 'glob', 'grep', 'web', 'mcp', 'task', 'other',
]);

/**
 * Builds one ReplayRow, preferring the stored action and falling back to the events join.
 *
 * The fallback has to decide whether `events.target` is a COMMAND or a PATH, because the event
 * row stores them in one column (`filePath ?? command`). The canonical tool name answers it:
 * `bash` means the string is a command, anything else means it is a path. That is the same
 * question `pipeline.ts` answered when it wrote the column, read back the same way round.
 */
function toReplayRow(r: Record<string, unknown>): ReplayRow {
  const base = {
    id: Number(r['id']),
    sessionId: String(r['sessionId'] ?? ''),
    agent: String(r['agent'] ?? '') as AgentId,
    ts: Number(r['ts']),
    layer: Number(r['layer']),
    severity: String(r['severity'] ?? ''),
    action: String(r['action'] ?? ''),
    rule: String(r['rule'] ?? ''),
    title: String(r['title'] ?? ''),
    attempted: String(r['attempted'] ?? ''),
    reason: String(r['reason'] ?? ''),
    tool: String(r['tool'] ?? ''),
    target: String(r['target'] ?? ''),
    cwd: String(r['cwd'] ?? ''),
    origin: String(r['origin'] ?? 'fixture') as IncidentOrigin,
  };

  const json = r['actionJson'];
  if (typeof json === 'string' && json !== '') {
    try {
      const parsed = JSON.parse(json) as ReplayableAction;
      return { ...base, provenance: 'stored', replayable: parsed };
    } catch {
      // A corrupt blob is UNAVAILABLE, never a silent fall-through to the lossy path. A replay
      // that quietly downgraded its own input would report a precision figure it could not
      // support.
      return { ...base, provenance: 'unavailable', unavailableReason: 'action_json is not valid JSON' };
    }
  }

  const n = Number(r['eventCount'] ?? 0);
  if (n === 0) {
    return {
      ...base,
      provenance: 'unavailable',
      unavailableReason: 'pre-v4 incident with no event row at the same (session, timestamp)',
    };
  }
  if (n > 1) {
    return {
      ...base,
      provenance: 'unavailable',
      unavailableReason: `ambiguous recovery: ${n} events share this (session, timestamp)`,
    };
  }

  const target = String(r['eventTarget'] ?? '');
  const rawTool = r['eventRawTool'] == null ? undefined : String(r['eventRawTool']);
  const toolRaw = r['eventTool'] == null ? undefined : String(r['eventTool']);
  const tool = toolRaw && CANONICAL_TOOLS.has(toolRaw) ? (toolRaw as CanonicalTool) : undefined;
  const kind = String(r['eventKind'] ?? 'pre_tool') as EventKind;
  const cwd = String(r['eventCwd'] ?? base.cwd);

  const act: ReplayableAction = {
    agent: base.agent,
    event: kind,
    cwd,
    ...(tool ? { tool } : {}),
    ...(rawTool ? { rawTool } : {}),
    ...(tool === 'bash' ? { command: target } : target !== '' ? { filePath: target } : {}),
  };
  return { ...base, provenance: 'recovered', replayable: act };
}

const SCHEMA_VERSION = 4;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  agent         TEXT NOT NULL,
  cwd           TEXT NOT NULL,
  origin        TEXT NOT NULL DEFAULT 'fixture',
  goal          TEXT,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  event_count   INTEGER NOT NULL DEFAULT 0,
  judge_calls   INTEGER NOT NULL DEFAULT 0,
  judge_cost    REAL    NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  agent       TEXT NOT NULL,
  event       TEXT NOT NULL,
  tool        TEXT,
  raw_tool    TEXT,
  target      TEXT,
  cwd         TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  origin      TEXT NOT NULL DEFAULT 'fixture',
  dedupe_hash TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, ts);
CREATE TABLE IF NOT EXISTS incidents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  agent       TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  layer       INTEGER NOT NULL,
  severity    TEXT NOT NULL,
  action      TEXT NOT NULL,
  rule        TEXT NOT NULL,
  title       TEXT NOT NULL,
  attempted   TEXT NOT NULL,
  action_json TEXT,
  reason      TEXT NOT NULL,
  tool        TEXT NOT NULL,
  target      TEXT NOT NULL,
  cwd         TEXT NOT NULL,
  live        INTEGER NOT NULL DEFAULT 0,
  origin      TEXT NOT NULL DEFAULT 'fixture',
  dedupe_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_incidents_ts ON incidents(ts DESC);
CREATE TABLE IF NOT EXISTS integrity (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  path        TEXT NOT NULL,
  hash        TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS counters (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS checklist (
  step    TEXT PRIMARY KEY,
  done_at INTEGER
);
CREATE TABLE IF NOT EXISTS judge_spend (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  provider   TEXT NOT NULL,
  model      TEXT NOT NULL,
  in_tokens  INTEGER NOT NULL,
  out_tokens INTEGER NOT NULL,
  cost_usd   REAL NOT NULL,
  mocked     INTEGER NOT NULL DEFAULT 0
);
`;

/**
 * Indexes over columns that arrived in schema v2. They are executed AFTER `migrate()` rather
 * than inside SCHEMA, because on a v1 database the columns do not exist yet and
 * `CREATE INDEX ... ON incidents(dedupe_hash)` would throw before the ALTER could add it.
 */
const V2_INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_incidents_dedupe ON incidents(dedupe_hash);
CREATE INDEX IF NOT EXISTS idx_incidents_origin ON incidents(origin);
CREATE INDEX IF NOT EXISTS idx_events_origin ON events(origin);
`;

export const CHECKLIST_STEPS = [
  'agents_detected',
  'policy_created',
  'protection_verified',
  'first_catch',
] as const;
export type ChecklistStep = (typeof CHECKLIST_STEPS)[number];

export class Store {
  readonly db: DatabaseSyncType;
  readonly file: string;
  private cache = new Map<string, StatementSync>();

  /** The database this store is reading. Reported by `usewarden replay` so a run says what it read. */
  get path(): string { return this.file; }

  constructor(file?: string) {
    this.file = file ?? dbPath();
    if (this.file !== ':memory:') {
      ensureHome();
      mkdirpSafe(path.dirname(this.file));
    }
    this.db = new (loadSqlite().DatabaseSync)(this.file);
    // WAL: hook processes from several agents write to this DB concurrently.
    if (this.file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(SCHEMA);
    this.migrate();
    this.db.exec(V2_INDEXES);
    this.setMeta('schema_version', String(SCHEMA_VERSION));
    for (const s of CHECKLIST_STEPS) {
      this.q('INSERT OR IGNORE INTO checklist(step, done_at) VALUES(?, NULL)').run(s);
    }
  }

  /**
   * Forward-only schema migration.
   *
   * v1 -> v2 adds the `origin` axis (live / demo / fixture) to sessions, events and incidents,
   * and a dedupe hash to incidents. Both exist for the same reason: before v2 every reported
   * number came from free-running counters that `usewarden demo` and duplicate hook deliveries
   * could both inflate. See docs/METRICS.md and DECISIONS D-069.
   *
   * Existing rows are backfilled from the one piece of provenance v1 did record: `live`. A v1
   * row with live=1 really was a real session, so it becomes 'live'; everything else becomes
   * 'fixture', which is the conservative direction - it can only ever UNDER-report.
   */
  private migrate(): void {
    const has = (table: string, col: string): boolean =>
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
        .some((c) => c.name === col);

    const addedSessions = !has('sessions', 'origin');
    const addedEvents = !has('events', 'origin');
    if (addedSessions) this.db.exec(`ALTER TABLE sessions ADD COLUMN origin TEXT NOT NULL DEFAULT 'fixture'`);
    if (addedEvents) this.db.exec(`ALTER TABLE events ADD COLUMN origin TEXT NOT NULL DEFAULT 'fixture'`);
    if (!has('incidents', 'origin')) {
      this.db.exec(`ALTER TABLE incidents ADD COLUMN origin TEXT NOT NULL DEFAULT 'fixture'`);
      this.db.exec(`UPDATE incidents SET origin='live' WHERE live=1`);
    }
    /**
     * Sessions and events have no `live` column of their own, so they are backfilled by
     * inference from the one thing v1 did record: a session that produced a live incident WAS a
     * live session, and its events were live events.
     *
     * Without this the first run against a real pre-v2 database reported eight blocked actions
     * against zero inspected events - technically conservative, since 'fixture' can only ever
     * under-report, but visibly impossible on screen. A migration whose output looks broken will
     * be assumed broken.
     */
    if (addedSessions) {
      this.db.exec(`UPDATE sessions SET origin='live'
                    WHERE id IN (SELECT DISTINCT session_id FROM incidents WHERE live=1)`);
    }
    if (addedEvents) {
      this.db.exec(`UPDATE events SET origin='live'
                    WHERE session_id IN (SELECT DISTINCT session_id FROM incidents WHERE live=1)`);
    }
    /**
     * v2 -> v3 exists because the SESSION RECEIPT needs two facts the store never kept.
     *
     * `events.context_fill` — peak context fill was only ever observable at the moment it crossed
     * `context.warn_pct`, i.e. only for sessions that had a problem. A receipt that can report the
     * number only when something went wrong is the exact shape this build keeps failing at.
     *
     * `judge_spend.session_id` — spend was attributable to the whole database and to nothing
     * smaller. `sessions.judge_calls` and `sessions.judge_cost` exist, and docs/METRICS.md forbids
     * reporting a stored counter: "derived, never counted... a counter can only be wrong forever".
     * So the receipt derives spend by query over this column instead.
     *
     * Both are added NULL. A pre-v3 row genuinely does not know its value, and the receipt reports
     * that as `unavailable` with the reason - never as zero. "I could not tell" and "it is fine"
     * are different sentences (CLAUDE.md §4.4).
     */
    if (!has('events', 'context_fill')) {
      this.db.exec(`ALTER TABLE events ADD COLUMN context_fill REAL`);
    }
    if (!has('judge_spend', 'session_id')) {
      this.db.exec(`ALTER TABLE judge_spend ADD COLUMN session_id TEXT`);
    }

    if (!has('incidents', 'dedupe_hash')) {
      // Left NULL for pre-v2 rows on purpose: SQLite treats NULLs as distinct in a UNIQUE
      // index, so history is preserved rather than being collapsed by a hash it never had.
      this.db.exec(`ALTER TABLE incidents ADD COLUMN dedupe_hash TEXT`);
    }

    /**
     * v3 -> v4 stores THE ACTION AS IT WAS, so an incident can be re-run against a ruleset it
     * predates. `incidents.attempted` is a display rendering — one-lined and cut at 200
     * characters — and 62 of the 92 real blocks on this machine hit that cut. A record that
     * cannot be replayed can tell you what happened and cannot tell you whether your fix worked.
     *
     * IT IS ADDED NULL AND IT IS NOT BACKFILLED. A pre-v4 row genuinely does not carry its own
     * replay input, and inventing one from the truncated display string would manufacture a
     * command the agent never ran — which is worse than an honest gap, because every precision
     * number computed downstream would then rest on fabricated input.
     *
     * Pre-v4 rows are not lost, though, and that is a correction to D-258 rather than a
     * backfill: `events.target` has always held `filePath ?? command` verbatim, untruncated,
     * newlines intact. `replayInputFor()` joins to it at READ time and labels the provenance of
     * every row it returns. Nothing is written back. See D-277.
     */
    if (!has('incidents', 'action_json')) {
      this.db.exec(`ALTER TABLE incidents ADD COLUMN action_json TEXT`);
    }
  }

  private q(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) { s = this.db.prepare(sql); this.cache.set(sql, s); }
    return s;
  }

  close(): void { try { this.db.close(); } catch { /* already closed */ } }

  // ---- meta ------------------------------------------------------------
  setMeta(key: string, value: string): void {
    this.q('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }
  getMeta(key: string): string | undefined {
    const r = this.q('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined;
    return r?.value;
  }

  // ---- sessions --------------------------------------------------------
  /**
   * Sessions are recorded with the origin of the event that created them, and the origin is
   * never upgraded afterwards: a session that began as a demo stays a demo for its whole life,
   * so nothing that starts synthetic can graduate into the live numbers.
   */
  upsertSession(id: string, agent: AgentId, cwd: string, ts: number, origin: IncidentOrigin = 'fixture'): void {
    this.q('INSERT INTO sessions(id,agent,cwd,started_at,origin) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
      .run(id, agent, cwd, ts, origin);
  }
  setGoal(sessionId: string, goal: string): void {
    this.q('UPDATE sessions SET goal=? WHERE id=?').run(goal, sessionId);
  }
  getGoal(sessionId: string): string | undefined {
    const r = this.q('SELECT goal FROM sessions WHERE id=?').get(sessionId) as { goal: string | null } | undefined;
    return r?.goal ?? undefined;
  }
  endSession(sessionId: string, ts: number): void {
    this.q('UPDATE sessions SET ended_at=? WHERE id=?').run(ts, sessionId);
  }
  sessionEventCount(sessionId: string): number {
    const r = this.q('SELECT event_count AS c FROM sessions WHERE id=?').get(sessionId) as { c: number } | undefined;
    return Number(r?.c ?? 0);
  }
  countSessions(origin?: IncidentOrigin): number {
    const r = origin === undefined
      ? this.q('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }
      : this.q('SELECT COUNT(*) AS c FROM sessions WHERE origin=?').get(origin) as { c: number };
    return Number(r.c);
  }
  countEvents(origin?: IncidentOrigin): number {
    const r = origin === undefined
      ? this.q('SELECT COUNT(*) AS c FROM events').get() as { c: number }
      : this.q('SELECT COUNT(*) AS c FROM events WHERE origin=?').get(origin) as { c: number };
    return Number(r.c);
  }

  /**
   * How many events each agent has actually delivered, and when the last one arrived.
   *
   * This is the only evidence usewarden has that a registered hook is EXECUTING rather than
   * merely written down. Every other check in `status` and `doctor` reads a config file, and
   * "the config contains my entries" is a different question from "anything ever ran" - which is
   * the whole subject of writeups/01-hook-not-running. Answering it needs no new bookkeeping:
   * the events table has carried `agent` and `ts` since the first schema.
   */
  eventStatsByAgent(): Map<string, { count: number; lastTs: number }> {
    const rows = this.q('SELECT agent, COUNT(*) AS c, MAX(ts) AS last FROM events GROUP BY agent')
      .all() as { agent: string; c: number; last: number }[];
    return new Map(rows.map((r) => [r.agent, { count: Number(r.c), lastTs: Number(r.last) }]));
  }

  // ---- events ----------------------------------------------------------
  /**
   * Records an event. Returns false when this is a duplicate delivery of an event we already
   * saw (Cursor can replay Claude Code hook config - HOOK-MATRIX "duplicate events",
   * DECISIONS D-005). Callers still evaluate policy on duplicates; only the counters skip.
   */
  recordEvent(e: NormalizedEvent, target: string, origin: IncidentOrigin = 'fixture'): boolean {
    const hash = dedupeHash(e, target);
    try {
      this.q(`INSERT INTO events(session_id,agent,event,tool,raw_tool,target,cwd,ts,origin,dedupe_hash,context_fill)
              VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .run(e.sessionId, e.agent, e.event, e.tool ?? null, e.rawTool ?? null, target, e.cwd, e.ts, origin, hash,
             typeof e.contextFill === 'number' ? e.contextFill : null);
    } catch {
      return false; // UNIQUE violation == duplicate delivery
    }
    this.q('UPDATE sessions SET event_count = event_count + 1 WHERE id=?').run(e.sessionId);
    this.bump('events_seen');
    return true;
  }

  /**
   * Has THIS session already written to one of these targets?
   *
   * The uncommitted-work guard in Layer 1 needs it. An agent's own first write makes a file dirty,
   * so without this the guard would refuse the agent's second write to its own file. What the
   * guard actually protects is work the agent did not do, and this is the record of what it did.
   *
   * Must be asked BEFORE `recordEvent` stores the current event, or the current write answers for
   * itself and the guard never fires.
   */
  sessionHasWrittenTo(sessionId: string, targets: readonly string[]): boolean {
    const uniq = [...new Set(targets.filter((t) => t !== ''))];
    if (uniq.length === 0) return false;
    const holes = uniq.map(() => '?').join(',');
    const r = this.q(`SELECT 1 AS x FROM events
                      WHERE session_id=? AND tool IN ('write','edit') AND target IN (${holes})
                      LIMIT 1`).get(sessionId, ...uniq) as { x: number } | undefined;
    return r !== undefined;
  }

  // ---- incidents -------------------------------------------------------
  /**
   * Records an incident, ONCE.
   *
   * The dedupe hash is the anti-double-count control. Before schema v2 an event that arrived
   * twice - the documented Cursor-replays-Claude-Code case (D-005), or an agent's own retry of
   * the same call inside the same tick - produced two incident rows and bumped every counter
   * twice, while the events table deduplicated the same pair down to one. That is how a clean
   * install could report twelve blocked actions against eight inspected events. The bucket is
   * the same 2s window `dedupeHash` uses, so a genuine repeat attempt seconds later is still
   * counted as the separate attempt it is.
   *
   * Returns the id of the row that now represents this incident - the new one, or the existing
   * one it collapsed into. Counters are bumped only for a genuinely new row.
   */
  addIncident(i: Incident, live: boolean, origin?: IncidentOrigin): number {
    const org: IncidentOrigin = origin ?? (live ? 'live' : 'fixture');
    const hash = incidentDedupeHash(i, org);
    // Serialised verbatim. No redaction, no truncation, no one-lining - see Incident.replayable.
    const actionJson = i.replayable ? JSON.stringify(i.replayable) : null;
    const r = this.q(`INSERT INTO incidents
      (session_id,agent,ts,layer,severity,action,rule,title,attempted,action_json,reason,tool,target,cwd,live,origin,dedupe_hash)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(dedupe_hash) DO NOTHING`)
      .run(i.sessionId, i.agent, i.ts, i.layer, i.severity, i.action, i.rule, i.title,
           i.attempted, actionJson, i.reason, i.tool, i.target, i.cwd, live ? 1 : 0, org, hash);
    if (Number(r.changes) === 0) {
      const existing = this.q('SELECT id FROM incidents WHERE dedupe_hash=?').get(hash) as { id: number } | undefined;
      return Number(existing?.id ?? 0);
    }
    if (i.action === 'block') this.bump('actions_blocked');
    if (i.layer === 2) this.bump('drift_caught');
    if (i.severity !== 'info') this.bump('catches');
    if (live) this.completeStep('first_catch', i.ts);
    return Number(r.lastInsertRowid);
  }
  recentIncidents(limit = 50): (Incident & { live: number; origin: IncidentOrigin })[] {
    return this.q(`SELECT id,session_id AS sessionId,agent,ts,layer,severity,action,rule,title,
                          attempted,reason,tool,target,cwd,live,origin
                   FROM incidents ORDER BY ts DESC, id DESC LIMIT ?`).all(limit) as never;
  }
  /** Incidents from ONE origin, newest first. The incident wall uses this to label demo cards. */
  incidentsByOrigin(origin: IncidentOrigin, limit = 50): (Incident & { live: number; origin: IncidentOrigin })[] {
    return this.q(`SELECT id,session_id AS sessionId,agent,ts,layer,severity,action,rule,title,
                          attempted,reason,tool,target,cwd,live,origin
                   FROM incidents WHERE origin=? ORDER BY ts DESC, id DESC LIMIT ?`).all(origin, limit) as never;
  }
  /**
   * ONE incident, by the id `addIncident` returned.
   *
   * `demo` used to render its card by asking for the newest row of its origin, which is a guess:
   * `ts` is millisecond-granular, the four demo scenarios are evaluated inside the same
   * millisecond, and `ORDER BY ts DESC` alone leaves tied rows in an order SQLite does not
   * define. The demo therefore printed an arbitrary one of the tied incidents - in practice the
   * curl-pipe-shell card twice - while correctly reporting four distinct blocks. Looking a row up
   * by the id the write returned removes the guess rather than making it more likely to be right.
   */
  incidentById(id: number): (Incident & { live: number; origin: IncidentOrigin }) | undefined {
    return this.q(`SELECT id,session_id AS sessionId,agent,ts,layer,severity,action,rule,title,
                          attempted,reason,tool,target,cwd,live,origin
                   FROM incidents WHERE id=?`).get(id) as never;
  }
  /**
   * THE REPLAY CORPUS: every stored incident, with the action that produced it and an honest
   * label saying where that action came from.
   *
   * Three provenances, and the distinction is the whole point of this method:
   *
   *   `stored`     the v4 `action_json` column. The action exactly as the agent sent it.
   *   `recovered`  reconstructed from the sibling `events` row. `events.target` has always held
   *                `filePath ?? command` VERBATIM - untruncated, newlines intact - and every
   *                incident is written in the same pipeline pass as its event, so the two share
   *                a session id and a millisecond timestamp. This is a READ-time join. Nothing
   *                is written back, and `incidents.attempted` is never overwritten.
   *   `unavailable` no v4 column and no joinable event. Reported as UNREPLAYABLE and counted
   *                against the total, never silently dropped and never guessed at.
   *
   * D-258 recorded that 34 of 35 incidents were unreplayable and that "restoring the truncated
   * tail is not" possible. That conclusion was drawn from `incidents.attempted` alone. It is
   * wrong: the untruncated text was in the events table the whole time. See D-277.
   *
   * The join is on (session_id, ts) and is verified rather than assumed - a timestamp collision
   * within one session would make the recovery ambiguous, so a row that matches more than one
   * event is returned as `unavailable` rather than as an arbitrary pick.
   */
  replayCorpus(origin?: IncidentOrigin): ReplayRow[] {
    const where = origin ? 'WHERE i.origin=?' : '';
    const sql = `SELECT i.id, i.session_id AS sessionId, i.agent, i.ts, i.layer, i.severity,
                        i.action, i.rule, i.title, i.attempted, i.reason, i.tool, i.target,
                        i.cwd, i.origin, i.action_json AS actionJson,
                        (SELECT COUNT(*) FROM events e
                          WHERE e.session_id=i.session_id AND e.ts=i.ts) AS eventCount,
                        (SELECT e.target FROM events e
                          WHERE e.session_id=i.session_id AND e.ts=i.ts LIMIT 1) AS eventTarget,
                        (SELECT e.tool FROM events e
                          WHERE e.session_id=i.session_id AND e.ts=i.ts LIMIT 1) AS eventTool,
                        (SELECT e.raw_tool FROM events e
                          WHERE e.session_id=i.session_id AND e.ts=i.ts LIMIT 1) AS eventRawTool,
                        (SELECT e.event FROM events e
                          WHERE e.session_id=i.session_id AND e.ts=i.ts LIMIT 1) AS eventKind,
                        (SELECT e.cwd FROM events e
                          WHERE e.session_id=i.session_id AND e.ts=i.ts LIMIT 1) AS eventCwd
                 FROM incidents i ${where} ORDER BY i.ts ASC, i.id ASC`;
    const rows = (origin ? this.q(sql).all(origin) : this.q(sql).all()) as Record<string, unknown>[];
    return rows.map((r) => toReplayRow(r));
  }

  countIncidents(): number {
    const r = this.q('SELECT COUNT(*) AS c FROM incidents').get() as { c: number };
    return Number(r.c);
  }
  countLiveIncidents(): number {
    const r = this.q('SELECT COUNT(*) AS c FROM incidents WHERE live=1').get() as { c: number };
    return Number(r.c);
  }

  // ---- counters --------------------------------------------------------
  bump(key: string, by = 1): void {
    this.q(`INSERT INTO counters(key,value) VALUES(?,?)
            ON CONFLICT(key) DO UPDATE SET value = value + excluded.value`).run(key, by);
  }
  counter(key: string): number {
    const r = this.q('SELECT value FROM counters WHERE key=?').get(key) as { value: number } | undefined;
    return Number(r?.value ?? 0);
  }
  allCounters(): Record<string, number> {
    const rows = this.q('SELECT key,value FROM counters').all() as { key: string; value: number }[];
    return Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]));
  }

  // ---- integrity -------------------------------------------------------
  putIntegrity(rec: IntegrityRecord): void {
    this.q(`INSERT INTO integrity(id,kind,path,hash,recorded_at) VALUES(?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET hash=excluded.hash, path=excluded.path,
            recorded_at=excluded.recorded_at`)
      .run(rec.id, rec.kind, rec.path, rec.hash, rec.recordedAt);
  }
  listIntegrity(): IntegrityRecord[] {
    return this.q('SELECT id,kind,path,hash,recorded_at AS recordedAt FROM integrity').all() as never;
  }
  clearIntegrity(): void { this.db.exec('DELETE FROM integrity'); }

  // ---- checklist -------------------------------------------------------
  completeStep(step: ChecklistStep, ts: number): void {
    this.q('UPDATE checklist SET done_at=? WHERE step=? AND done_at IS NULL').run(ts, step);
  }
  checklist(): { step: string; done: boolean; doneAt: number | null }[] {
    const rows = this.q('SELECT step,done_at FROM checklist').all() as { step: string; done_at: number | null }[];
    const order = new Map(CHECKLIST_STEPS.map((s, i) => [s as string, i]));
    return rows
      .sort((a, b) => (order.get(a.step) ?? 9) - (order.get(b.step) ?? 9))
      .map((r) => ({ step: r.step, done: r.done_at !== null, doneAt: r.done_at }));
  }

  // ---- judge spend -----------------------------------------------------
  recordJudgeSpend(provider: string, model: string, inTok: number, outTok: number, cost: number, mocked: boolean, sessionId?: string): void {
    this.q(`INSERT INTO judge_spend(ts,provider,model,in_tokens,out_tokens,cost_usd,mocked,session_id)
            VALUES(?,?,?,?,?,?,?,?)`)
      .run(Date.now(), provider, model, inTok, outTok, cost, mocked ? 1 : 0, sessionId ?? null);
  }
  /**
   * `usd` only covers METERED providers. Calls routed through a local agent CLI cost the user
   * real subscription quota but yield no token counts, so usewarden reports them as a separate
   * count rather than inventing a dollar figure for them (spec 3.6: no invented precision).
   */
  totalJudgeSpend(): { calls: number; mocked: number; unmetered: number; inTok: number; outTok: number; usd: number } {
    const r = this.q(`SELECT COUNT(*) AS calls, COALESCE(SUM(mocked),0) AS mocked,
                             COALESCE(SUM(provider LIKE 'local-%'),0) AS unmetered,
                             COALESCE(SUM(in_tokens),0) AS inTok, COALESCE(SUM(out_tokens),0) AS outTok,
                             COALESCE(SUM(cost_usd),0) AS usd FROM judge_spend`).get() as unknown as
      { calls: number; mocked: number; unmetered: number; inTok: number; outTok: number; usd: number };
    return {
      calls: Number(r.calls), mocked: Number(r.mocked), unmetered: Number(r.unmetered),
      inTok: Number(r.inTok), outTok: Number(r.outTok), usd: Number(r.usd),
    };
  }
}

/**
 * Dedupe key. Deliberately excludes the agent id, because Cursor may replay a Claude Code hook
 * for the same logical call (DECISIONS D-005). Timestamps are bucketed to 2s so two deliveries
 * of one call collapse, while two genuinely identical calls seconds apart do not.
 */
export function incidentDedupeHash(i: Incident, origin: IncidentOrigin): string {
  const bucket = Math.floor(i.ts / 2000);
  return sha256([origin, i.sessionId, String(i.layer), i.rule, i.action, i.tool, i.target, String(bucket)].join(' '));
}

export function dedupeHash(e: NormalizedEvent, target: string): string {
  const bucket = Math.floor(e.ts / 2000);
  return sha256([e.sessionId, e.event, e.tool ?? '', target, String(bucket)].join(' '));
}
