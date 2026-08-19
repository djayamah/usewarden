import './boot.js';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType, StatementSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentId, Incident, IntegrityRecord, NormalizedEvent } from './types.js';
import { dbPath, ensureHome } from './paths.js';
import { sha256 } from './util.js';

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

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  agent         TEXT NOT NULL,
  cwd           TEXT NOT NULL,
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
  reason      TEXT NOT NULL,
  tool        TEXT NOT NULL,
  target      TEXT NOT NULL,
  cwd         TEXT NOT NULL,
  live        INTEGER NOT NULL DEFAULT 0
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

  constructor(file?: string) {
    this.file = file ?? dbPath();
    if (this.file !== ':memory:') {
      ensureHome();
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    }
    this.db = new (loadSqlite().DatabaseSync)(this.file);
    // WAL: hook processes from several agents write to this DB concurrently.
    if (this.file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(SCHEMA);
    this.setMeta('schema_version', String(SCHEMA_VERSION));
    for (const s of CHECKLIST_STEPS) {
      this.q('INSERT OR IGNORE INTO checklist(step, done_at) VALUES(?, NULL)').run(s);
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
  upsertSession(id: string, agent: AgentId, cwd: string, ts: number): void {
    this.q('INSERT INTO sessions(id,agent,cwd,started_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING')
      .run(id, agent, cwd, ts);
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
  countSessions(): number {
    const r = this.q('SELECT COUNT(*) AS c FROM sessions').get() as { c: number };
    return Number(r.c);
  }

  // ---- events ----------------------------------------------------------
  /**
   * Records an event. Returns false when this is a duplicate delivery of an event we already
   * saw (Cursor can replay Claude Code hook config - HOOK-MATRIX "duplicate events",
   * DECISIONS D-005). Callers still evaluate policy on duplicates; only the counters skip.
   */
  recordEvent(e: NormalizedEvent, target: string): boolean {
    const hash = dedupeHash(e, target);
    try {
      this.q(`INSERT INTO events(session_id,agent,event,tool,raw_tool,target,cwd,ts,dedupe_hash)
              VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(e.sessionId, e.agent, e.event, e.tool ?? null, e.rawTool ?? null, target, e.cwd, e.ts, hash);
    } catch {
      return false; // UNIQUE violation == duplicate delivery
    }
    this.q('UPDATE sessions SET event_count = event_count + 1 WHERE id=?').run(e.sessionId);
    this.bump('events_seen');
    return true;
  }

  // ---- incidents -------------------------------------------------------
  addIncident(i: Incident, live: boolean): number {
    const r = this.q(`INSERT INTO incidents
      (session_id,agent,ts,layer,severity,action,rule,title,attempted,reason,tool,target,cwd,live)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(i.sessionId, i.agent, i.ts, i.layer, i.severity, i.action, i.rule, i.title,
           i.attempted, i.reason, i.tool, i.target, i.cwd, live ? 1 : 0);
    if (i.action === 'block') this.bump('actions_blocked');
    if (i.layer === 2) this.bump('drift_caught');
    if (i.severity !== 'info') this.bump('catches');
    if (live) this.completeStep('first_catch', i.ts);
    return Number(r.lastInsertRowid);
  }
  recentIncidents(limit = 50): (Incident & { live: number })[] {
    return this.q(`SELECT id,session_id AS sessionId,agent,ts,layer,severity,action,rule,title,
                          attempted,reason,tool,target,cwd,live
                   FROM incidents ORDER BY ts DESC LIMIT ?`).all(limit) as never;
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
  recordJudgeSpend(provider: string, model: string, inTok: number, outTok: number, cost: number, mocked: boolean): void {
    this.q(`INSERT INTO judge_spend(ts,provider,model,in_tokens,out_tokens,cost_usd,mocked)
            VALUES(?,?,?,?,?,?,?)`)
      .run(Date.now(), provider, model, inTok, outTok, cost, mocked ? 1 : 0);
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
export function dedupeHash(e: NormalizedEvent, target: string): string {
  const bucket = Math.floor(e.ts / 2000);
  return sha256([e.sessionId, e.event, e.tool ?? '', target, String(bucket)].join(' '));
}
