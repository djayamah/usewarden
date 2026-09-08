import './boot.js';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { dbPath } from './paths.js';
import { mkdirpSafe } from './util.js';

/**
 * Copying the record off the one disk it lives on.
 *
 * WHY THIS IS NOT `cp`, and why that distinction is the whole module.
 *
 * `~/.usewarden/usewarden.db` runs in WAL mode (see Store's constructor) because hook processes
 * from several agents write to it concurrently. In WAL mode the committed state of the database
 * is split across `usewarden.db` and `usewarden.db-wal`, and a reader reconciles the two through
 * `usewarden.db-shm`. A file-level backup — restic, rsync, Time Machine, `cp` — walks those three
 * files at three different instants while writes are in flight, and there is no guarantee the set
 * it captures is a set that ever existed together. The result opens, reports no error, and is
 * missing or duplicating whatever was mid-commit.
 *
 * `VACUUM INTO` is SQLite's own answer: it takes a read transaction, so it sees exactly one
 * committed snapshot, and writes a single self-contained file with no sidecars. That file is a
 * database, not a copy of one — which is why the verification below can open it and count rows.
 *
 * Every snapshot is verified before it is called a snapshot: `PRAGMA integrity_check`, then a row
 * count of each table compared against the source. §4.1 — verify by looking. A backup that has
 * only been written has not been verified, and a backup nobody has read out of is not a backup.
 */

type SqliteModule = { DatabaseSync: new (path: string, options?: unknown) => DatabaseSyncType };
let sqlite: SqliteModule | undefined;
function loadSqlite(): SqliteModule {
  if (!sqlite) sqlite = createRequire(import.meta.url)('node:sqlite') as SqliteModule;
  return sqlite;
}

/** Tables whose row counts must survive the snapshot exactly. */
const COUNTED_TABLES = ['sessions', 'events', 'incidents'] as const;

export interface CorpusCounts {
  sessions: number;
  events: number;
  incidents: number;
  /** Incidents from real agent sessions — the part of the corpus that cannot be regenerated. */
  liveIncidents: number;
}

export interface BackupResult {
  /** Absolute path of the snapshot database. */
  file: string;
  /** Absolute path of the JSON receipt written beside it. */
  receipt: string;
  bytes: number;
  sha256: string;
  counts: CorpusCounts;
  /** Snapshots deleted by the retention pass, oldest first. */
  pruned: string[];
  /** Wall-clock milliseconds the snapshot took, so a future regression in cost is visible. */
  ms: number;
}

export class BackupError extends Error {
  constructor(message: string) { super(message); this.name = 'BackupError'; }
}

const STEM = 'usewarden-corpus-';

/** `2026-08-26T15-04-05Z` — sortable, filename-safe, and unambiguous about the zone. */
export function stampFor(d: Date): string {
  return d.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
}

function countsOf(db: DatabaseSyncType): CorpusCounts {
  const n = (sql: string): number => Number((db.prepare(sql).get() as { c: number }).c);
  return {
    sessions: n('SELECT COUNT(*) AS c FROM sessions'),
    events: n('SELECT COUNT(*) AS c FROM events'),
    incidents: n('SELECT COUNT(*) AS c FROM incidents'),
    liveIncidents: n(`SELECT COUNT(*) AS c FROM incidents WHERE origin = 'live'`),
  };
}

function sha256File(file: string): string {
  const h = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const read = fs.readSync(fd, buf, 0, buf.length, null);
      if (read === 0) break;
      h.update(buf.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

export interface BackupOptions {
  /** Source database. Defaults to the live corpus. */
  source?: string;
  /** How many snapshots to keep. 0 keeps everything. */
  keep?: number;
  /** Injected in tests so a snapshot's name is deterministic. */
  now?: Date;
}

/**
 * Write one verified snapshot of the corpus into `destDir` and return what it contains.
 *
 * Throws rather than returning a partial result: a half-written snapshot beside a receipt that
 * describes a whole one is the failure this whole file exists to avoid (§4.5 — a halt must never
 * resemble a completion). The temp file is removed on every failure path.
 */
export function backupCorpus(destDir: string, opts: BackupOptions = {}): BackupResult {
  const started = Date.now();
  const source = path.resolve(opts.source ?? dbPath());
  if (!fs.existsSync(source)) {
    throw new BackupError(`no corpus to back up: ${source} does not exist`);
  }

  const dir = path.resolve(destDir);
  mkdirpSafe(dir);

  const stamp = stampFor(opts.now ?? new Date());
  const final = path.join(dir, `${STEM}${stamp}.db`);
  // Written under a temp name and renamed only once verified, so a reader can never find a
  // `usewarden-corpus-*.db` that has not passed integrity_check.
  const tmp = `${final}.partial`;
  for (const stale of [tmp, final]) {
    if (fs.existsSync(stale)) fs.rmSync(stale, { force: true });
  }

  let sourceCounts: CorpusCounts;
  const src = new (loadSqlite().DatabaseSync)(source);
  try {
    src.exec('PRAGMA busy_timeout = 5000');
    // The bound parameter is what keeps a path containing a quote from being a SQL problem;
    // VACUUM INTO takes an expression, so the filename may be a parameter.
    src.prepare('VACUUM INTO ?').run(tmp);
    sourceCounts = countsOf(src);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw new BackupError(`could not snapshot ${source}: ${(e as Error).message}`);
  } finally {
    try { src.close(); } catch { /* already closed */ }
  }

  // --- verify by looking: open the snapshot and read it, do not trust the write ---------------
  let snapCounts: CorpusCounts;
  const snap = new (loadSqlite().DatabaseSync)(tmp);
  try {
    const integrity = String((snap.prepare('PRAGMA integrity_check').get() as { integrity_check: string })
      .integrity_check);
    if (integrity !== 'ok') {
      throw new BackupError(`snapshot failed integrity_check: ${integrity}`);
    }
    snapCounts = countsOf(snap);
  } catch (e) {
    try { snap.close(); } catch { /* ignore */ }
    fs.rmSync(tmp, { force: true });
    throw e instanceof BackupError ? e : new BackupError(`snapshot unreadable: ${(e as Error).message}`);
  } finally {
    try { snap.close(); } catch { /* already closed */ }
  }

  for (const t of COUNTED_TABLES) {
    if (snapCounts[t] !== sourceCounts[t]) {
      fs.rmSync(tmp, { force: true });
      throw new BackupError(
        `snapshot lost rows: ${t} is ${snapCounts[t]} in the snapshot and ${sourceCounts[t]} in the source`,
      );
    }
  }

  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, final);

  const bytes = fs.statSync(final).size;
  const digest = sha256File(final);
  const ms = Date.now() - started;

  const receipt = path.join(dir, `${STEM}${stamp}.json`);
  fs.writeFileSync(receipt, JSON.stringify({
    tool: 'usewarden backup',
    written_at: (opts.now ?? new Date()).toISOString(),
    source,
    file: path.basename(final),
    bytes,
    sha256: digest,
    counts: snapCounts,
    integrity_check: 'ok',
    method: 'sqlite VACUUM INTO',
    ms,
    verify: `shasum -a 256 ${path.basename(final)}`,
  }, null, 2) + '\n', { mode: 0o600 });

  const pruned = prune(dir, opts.keep ?? 7);
  return { file: final, receipt, bytes, sha256: digest, counts: snapCounts, pruned, ms };
}

/** Delete all but the newest `keep` snapshots, by the timestamp in the name. */
export function prune(dir: string, keep: number): string[] {
  if (keep <= 0) return [];
  const names = listSnapshots(dir);
  const doomed = names.slice(0, Math.max(0, names.length - keep));
  for (const n of doomed) {
    fs.rmSync(path.join(dir, `${n}.db`), { force: true });
    fs.rmSync(path.join(dir, `${n}.json`), { force: true });
  }
  return doomed;
}

/** Snapshot stems present in `dir`, oldest first. */
export function listSnapshots(dir: string): string[] {
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  return entries
    .filter((f) => f.startsWith(STEM) && f.endsWith('.db'))
    .map((f) => f.slice(0, -3))
    .sort();
}

/** Milliseconds since the newest snapshot in `dir`, or null when there is none. */
export function ageOfNewest(dir: string, now = Date.now()): number | null {
  const names = listSnapshots(dir);
  const newest = names[names.length - 1];
  if (!newest) return null;
  try {
    // Clamped at zero. mtimeMs can land a fraction of a millisecond AFTER a `now` captured just
    // before the write, and a negative age is not a thing — it read as "-0.19 ms old" in a test.
    return Math.max(0, now - fs.statSync(path.join(dir, `${newest}.db`)).mtimeMs);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The automatic path
// ---------------------------------------------------------------------------

/**
 * A corpus this big is not snapshotted inside a hook.
 *
 * `VACUUM INTO` is linear in database size, and the hook path has a hard deadline (hook.ts H4).
 * At the observed rate — ~5,000 events in six days for about 6.5 MB — this ceiling is years away,
 * and if it is ever reached the right answer is a deliberate `usewarden backup`, not a hook that
 * has quietly started taking seconds. The skip is logged, never silent.
 */
export const AUTO_MAX_BYTES = 512 * 1024 * 1024;

export interface AutoBackupConfig {
  dir: string | null;
  every_hours: number;
  keep: number;
}

/**
 * Refresh the snapshot at `session_end` if the newest one has aged out. Never throws.
 *
 * Returns a line for `usewarden.log`, or null when there was nothing to do. Off unless
 * `backup.dir` is set, and when off it costs one null check.
 */
export function maybeAutoBackup(cfg: AutoBackupConfig, now = Date.now()): string | null {
  if (!cfg.dir) return null;
  try {
    const dir = resolveDir(cfg.dir);
    const age = ageOfNewest(dir, now);
    const dueAfterMs = Math.max(0, cfg.every_hours) * 3600_000;
    if (age !== null && age < dueAfterMs) return null;

    const src = dbPath();
    const size = fs.existsSync(src) ? fs.statSync(src).size : 0;
    if (size > AUTO_MAX_BYTES) {
      return `backup skipped: corpus is ${(size / 1024 / 1024).toFixed(0)} MB, over the ` +
             `${AUTO_MAX_BYTES / 1024 / 1024} MB hook ceiling. Run "usewarden backup" directly.`;
    }

    const r = backupCorpus(dir, { keep: cfg.keep, now: new Date(now) });
    return `backup ok: ${r.file} (${r.bytes} bytes, ${r.counts.incidents} incidents, ${r.ms} ms)`;
  } catch (e) {
    // H3: a guardian that crashes the agent gets uninstalled within the hour. A backup that
    // could not be taken is a log line, never an exception into the hook path.
    return `backup failed: ${(e as Error).message}`;
  }
}

function resolveDir(dir: string): string {
  if (dir === '~') return process.env['HOME'] ?? dir;
  if (dir.startsWith('~/') && process.env['HOME']) return path.join(process.env['HOME'], dir.slice(2));
  return path.resolve(dir);
}
