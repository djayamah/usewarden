import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type { ValidPayload } from './validate.js';

/**
 * Aggregate-only storage.
 *
 * There is deliberately no per-submission table and no identifier column. A submission is folded
 * into a daily bucket the instant it is accepted and its individual shape is gone: you cannot
 * reconstruct one install from this database because the rows to do it with were never written.
 * That is a stronger guarantee than a retention policy, because it does not depend on anyone
 * remembering to run a deletion job.
 *
 * The bucket key is (day, platform, node major, sorted agent set). Nothing finer. `submissions`
 * counts how many payloads folded into a bucket, which is what the k-anonymity threshold on
 * `/v1/stats` needs and is also the only volume signal the service keeps.
 */
type SqliteModule = { DatabaseSync: new (path: string, options?: unknown) => DatabaseSyncType };
let sqlite: SqliteModule | undefined;
function loadSqlite(): SqliteModule {
  if (!sqlite) sqlite = createRequire(import.meta.url)('node:sqlite') as SqliteModule;
  return sqlite;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS buckets (
  day             TEXT NOT NULL,
  platform        TEXT NOT NULL,
  node            TEXT NOT NULL,
  agents          TEXT NOT NULL,
  submissions     INTEGER NOT NULL DEFAULT 0,
  events_seen     INTEGER NOT NULL DEFAULT 0,
  actions_blocked INTEGER NOT NULL DEFAULT 0,
  drift_caught    INTEGER NOT NULL DEFAULT 0,
  sessions        INTEGER NOT NULL DEFAULT 0,
  live_catches    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, platform, node, agents)
);
CREATE TABLE IF NOT EXISTS rule_totals (
  day         TEXT NOT NULL,
  rule        TEXT NOT NULL,
  hits        INTEGER NOT NULL DEFAULT 0,
  submissions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, rule)
);
CREATE TABLE IF NOT EXISTS checklist_totals (
  day         TEXT NOT NULL,
  step        TEXT NOT NULL,
  submissions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, step)
);
CREATE TABLE IF NOT EXISTS rejections (
  day    TEXT NOT NULL,
  reason TEXT NOT NULL,
  n      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, reason)
);
`;

/** Buckets thinner than this are suppressed from /v1/stats entirely. */
export const K_ANONYMITY_THRESHOLD = 5;

export interface StatsBucket {
  day: string;
  platform: string;
  node: string;
  agents: string;
  submissions: number;
  events_seen: number;
  actions_blocked: number;
  drift_caught: number;
  sessions: number;
  live_catches: number;
}

export interface Stats {
  threshold: number;
  buckets: StatsBucket[];
  suppressed_buckets: number;
  /** `submissions`, never "installs": this service cannot count installs and does not pretend to. */
  rules: { day: string; rule: string; hits: number; submissions: number }[];
  checklist: { day: string; step: string; submissions: number }[];
  rejections: { day: string; reason: string; n: number }[];
}

export class AggregateDb {
  readonly db: DatabaseSyncType;

  constructor(file = ':memory:') {
    this.db = new (loadSqlite().DatabaseSync)(file);
    if (file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(SCHEMA);
  }

  close(): void { try { this.db.close(); } catch { /* already closed */ } }

  /** Folds one accepted payload into its daily bucket. `day` is supplied so tests are hermetic. */
  fold(p: ValidPayload, day: string): void {
    const agents = [...p.agents].sort().join(',');
    this.db.prepare(`INSERT INTO buckets
      (day,platform,node,agents,submissions,events_seen,actions_blocked,drift_caught,sessions,live_catches)
      VALUES(?,?,?,?,1,?,?,?,?,?)
      ON CONFLICT(day,platform,node,agents) DO UPDATE SET
        submissions     = submissions     + 1,
        events_seen     = events_seen     + excluded.events_seen,
        actions_blocked = actions_blocked + excluded.actions_blocked,
        drift_caught    = drift_caught    + excluded.drift_caught,
        sessions        = sessions        + excluded.sessions,
        live_catches    = live_catches    + excluded.live_catches`)
      .run(day, p.platform, p.node, agents, p.counts.events_seen, p.counts.actions_blocked,
        p.counts.drift_caught, p.counts.sessions, p.counts.live_catches);

    for (const [rule, hits] of Object.entries(p.rules)) {
      this.db.prepare(`INSERT INTO rule_totals(day,rule,hits,submissions) VALUES(?,?,?,1)
        ON CONFLICT(day,rule) DO UPDATE SET hits = hits + excluded.hits, submissions = submissions + 1`)
        .run(day, rule, hits);
    }
    for (const step of p.checklist) {
      this.db.prepare(`INSERT INTO checklist_totals(day,step,submissions) VALUES(?,?,1)
        ON CONFLICT(day,step) DO UPDATE SET submissions = submissions + 1`).run(day, step);
    }
  }

  /** Rejections are counted by REASON CODE only. The payload that caused one is never stored. */
  recordRejection(reason: string, day: string): void {
    this.db.prepare(`INSERT INTO rejections(day,reason,n) VALUES(?,?,1)
      ON CONFLICT(day,reason) DO UPDATE SET n = n + 1`).run(day, reason);
  }

  /**
   * Aggregates for publication. Any bucket with fewer than K_ANONYMITY_THRESHOLD submissions is
   * dropped rather than rounded: a bucket of one is a description of one machine, and a count of
   * how many were dropped is published instead so the suppression is visible rather than silent.
   */
  stats(): Stats {
    const all = this.db.prepare('SELECT * FROM buckets ORDER BY day DESC, platform, node, agents')
      .all() as unknown as StatsBucket[];
    const buckets = all.filter((b) => Number(b.submissions) >= K_ANONYMITY_THRESHOLD);
    return {
      threshold: K_ANONYMITY_THRESHOLD,
      buckets,
      suppressed_buckets: all.length - buckets.length,
      rules: (this.db.prepare('SELECT day,rule,hits,submissions FROM rule_totals ORDER BY day DESC, hits DESC')
        .all() as unknown as Stats['rules']).filter((r) => Number(r.submissions) >= K_ANONYMITY_THRESHOLD),
      checklist: (this.db.prepare('SELECT day,step,submissions FROM checklist_totals ORDER BY day DESC')
        .all() as unknown as Stats['checklist']).filter((c) => Number(c.submissions) >= K_ANONYMITY_THRESHOLD),
      // Rejection reasons are usewarden's own fixed vocabulary, never user data, so they are not
      // suppressed - a rejection wave is exactly the thing an operator needs to see immediately.
      rejections: this.db.prepare('SELECT day,reason,n FROM rejections ORDER BY day DESC, n DESC')
        .all() as unknown as Stats['rejections'],
    };
  }
}
