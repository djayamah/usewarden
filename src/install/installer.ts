import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentId, IntegrityRecord } from '../types.js';
import { backupsDir, ensureHome, usewardenHome } from '../paths.js';
import { mkdirpSafe, sha256 } from '../util.js';
import { detectAgents, detectAllScopes, type Detection, type Scope } from './detect.js';
import { openCodePlugin, planFor, USEWARDEN_TAG } from './entries.js';
import { isDirty, previewDiff, readJsonFile, serialize, type JsonFile } from './jsonfile.js';
import type { Store } from '../store.js';

/**
 * `usewarden init` / `usewarden uninstall` / `usewarden restore-configs`.
 *
 * Guarantees this module is responsible for, each with a test in tests/installer.test.ts:
 *   G1  A timestamped backup is written BEFORE any config file is touched.
 *   G2  A diff preview of every change is produced; in non-interactive mode it is written next
 *       to the backup rather than skipped.
 *   G3  Only usewarden's own subtree is added or removed. Unrelated keys, key order, indentation
 *       and the trailing newline survive a round-trip byte-identically.
 *   G4  `init` is idempotent: a second run writes nothing.
 *   G5  `uninstall` restores every touched config byte-identically to the pre-init bytes.
 *   G6  A hash of usewarden's registered entries is recorded so `status` can detect TAMPERED.
 *   G7  Creating a previously-absent config counts as a mutation and is reported (CVE-2026-25725).
 */

export interface PlannedChange {
  agent: AgentId;
  label: string;
  scope: Scope;
  configPath: string;
  /** True when usewarden would create a file that does not exist yet. */
  creates: boolean;
  before: string;
  after: string;
  diff: string;
  changed: boolean;
  /**
   * True when the hooks CONTAINER key (e.g. `hooks`) did not exist before usewarden ran, so
   * `uninstall` knows to remove the empty shell it created rather than leaving `"hooks": {}`
   * behind. Found by the clean-machine simulation: without this, uninstall was one key short of
   * byte-identical on a config that had never had a hooks block.
   */
  createdContainer: boolean;
  caveat?: string;
}

export interface InitResult {
  changes: PlannedChange[];
  applied: boolean;
  backupDir?: string;
  errors: string[];
}

/**
 * Absolute path to usewarden's own CLI SCRIPT. Never relative, never resolved through PATH.
 */
export function usewardenScriptPath(): string {
  const override = process.env['USEWARDEN_BIN'];
  if (override && override.trim() !== '') return path.resolve(override);
  // dist/src/install/installer.js -> dist/src/cli.js
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'cli.js');
}

/**
 * Absolute path to the Node binary usewarden will be launched with.
 *
 * Usewarden registers `<abs node> <abs script> hook <agent> <kind>` rather than `<abs script> ...`.
 * This was not the first design: registering the script alone was measured failing in a REAL
 * Claude Code session with `EACCES: permission denied, posix_spawn` because the built script had
 * no execute bit, and every hook silently no-opped while `usewarden status` still said PROTECTED.
 * Naming the interpreter explicitly removes three failure modes at once - the execute bit, the
 * shebang, and Windows, where shebangs do not exist at all - and keeps every component of the
 * command an absolute path (THREAT-MODEL T-04).
 */
export function nodePath(): string {
  const override = process.env['USEWARDEN_NODE'];
  if (override && override.trim() !== '') return path.resolve(override);
  return process.execPath;
}

/** Back-compat alias used by status/doctor output. */
export function usewardenBinPath(): string { return usewardenScriptPath(); }

export interface PlanOptions {
  only?: AgentId[];
  /** `user` (default) registers in the agent's home config; `project` in the repo-local one. */
  scope?: Scope;
  projectRoot?: string;
}

/** Computes what `usewarden init` would do, without writing anything. */
export function planInit(opts: PlanOptions = {}): PlannedChange[] {
  const bin = usewardenScriptPath();
  const changes: PlannedChange[] = [];
  const detectOpts: { scope?: Scope; projectRoot?: string } = {};
  if (opts.scope) detectOpts.scope = opts.scope;
  if (opts.projectRoot) detectOpts.projectRoot = opts.projectRoot;
  for (const d of detectAgents(detectOpts)) {
    if (!d.installed) continue;
    if (opts.only && !opts.only.includes(d.agent)) continue;
    try {
      changes.push(planOne(d, bin));
    } catch (e) {
      changes.push({
        agent: d.agent, label: d.label, scope: d.scope, configPath: d.configPath, creates: false,
        before: '', after: '', changed: false, createdContainer: false,
        diff: `!! cannot plan: ${(e as Error).message}`,
        ...(d.caveat ? { caveat: d.caveat } : {}),
      });
    }
  }
  return changes;
}

function planOne(d: Detection, bin: string): PlannedChange {
  if (d.format === 'plugin') {
    const after = openCodePlugin(bin);
    const before = fs.existsSync(d.configPath) ? fs.readFileSync(d.configPath, 'utf8') : '';
    return {
      agent: d.agent, label: d.label, scope: d.scope, configPath: d.configPath,
      creates: !d.configExists, before, after, createdContainer: false,
      diff: previewDiff(before, after, d.configPath),
      changed: before !== after,
      ...(d.caveat ? { caveat: d.caveat } : {}),
    };
  }
  const f = readJsonFile(d.configPath);
  const before = f.raw;
  const containerKey = planFor(d.agent, bin).containerPath[0];
  const createdContainer = containerKey !== undefined && f.value[containerKey] === undefined;
  mergeEntries(f, d.agent, bin);
  const after = serialize(f);
  return {
    agent: d.agent, label: d.label, scope: d.scope, configPath: d.configPath,
    creates: !d.configExists, before, after, createdContainer,
    diff: previewDiff(before, after, d.configPath),
    changed: before !== after,
    ...(d.caveat ? { caveat: d.caveat } : {}),
  };
}

/** Meta key recording that usewarden, not the user, created the hooks container in a config. */
export function createdContainerKey(configPath: string): string {
  return `created_container:${configPath}`;
}

/** Adds usewarden's entries into `f.value`, replacing any usewarden entries already present. */
export function mergeEntries(f: JsonFile, agent: AgentId, bin: string): void {
  const plan = planFor(agent, bin);
  if (plan.containerPath.length === 0) return;
  let node = f.value;
  for (const key of plan.containerPath) {
    const next = node[key];
    if (next === undefined || next === null) {
      node[key] = {};
    } else if (typeof next !== 'object' || Array.isArray(next)) {
      throw new Error(`${f.path}: "${key}" exists but is not an object; refusing to overwrite it`);
    }
    node = node[key] as Record<string, unknown>;
  }
  for (const [k, v] of Object.entries(plan.containerDefaults ?? {})) {
    if (node[k] === undefined) node[k] = v;
  }
  for (const [evName, usewardenEntries] of Object.entries(plan.entries)) {
    const existing = Array.isArray(node[evName]) ? (node[evName] as unknown[]) : [];
    const foreign = existing.filter((x) => !isUsewardenEntry(x));
    node[evName] = [...foreign, ...usewardenEntries];
  }
}

/**
 * Removes usewarden's entries.
 *
 * `dropEmptyContainer` deletes the container key itself when usewarden created it and nothing else
 * is left inside. Without that, a config that never had a `hooks` block came back from
 * `uninstall` carrying an empty `"hooks": {}` - one key short of byte-identical, which the
 * clean-machine simulation caught and the unit test did not, because the unit fixture already
 * had a hooks block.
 */
export function removeEntries(f: JsonFile, agent: AgentId, dropEmptyContainer = false): void {
  const plan = planFor(agent, 'unused');
  if (plan.containerPath.length === 0) return;
  let node: Record<string, unknown> | undefined = f.value;
  for (const key of plan.containerPath) {
    const next: unknown = node?.[key];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) return;
    node = next as Record<string, unknown>;
  }
  if (!node) return;
  for (const evName of Object.keys(plan.entries)) {
    const existing = node[evName];
    if (!Array.isArray(existing)) continue;
    const foreign = existing.filter((x) => !isUsewardenEntry(x));
    if (foreign.length === 0) delete node[evName];
    else node[evName] = foreign;
  }
  // Usewarden also adds container defaults (e.g. Cursor's `version: 1`); if only those remain,
  // the container is still effectively empty.
  const defaults = Object.keys(plan.containerDefaults ?? {});
  const remaining = Object.keys(node).filter((k) => !defaults.includes(k));
  if (dropEmptyContainer && remaining.length === 0) {
    const key = plan.containerPath[0]!;
    let parent: Record<string, unknown> = f.value;
    for (const k of plan.containerPath.slice(0, -1)) parent = parent[k] as Record<string, unknown>;
    delete parent[plan.containerPath.length === 1 ? key : plan.containerPath[plan.containerPath.length - 1]!];
  }
}

export function isUsewardenEntry(x: unknown): boolean {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  if (o[USEWARDEN_TAG] === true) return true;
  const hooks = o['hooks'];
  if (Array.isArray(hooks)) return hooks.some((h) => isUsewardenEntry(h));
  return false;
}

/** The usewarden-owned subtree of a config, canonicalized for hashing. */
export function extractUsewardenEntries(configPath: string, agent: AgentId): unknown {
  if (!fs.existsSync(configPath)) return null;
  if (agent === 'opencode') return sha256(fs.readFileSync(configPath));
  let f: JsonFile;
  try { f = readJsonFile(configPath); } catch { return '<<unparseable>>'; }
  const plan = planFor(agent, 'unused');
  let node: Record<string, unknown> | undefined = f.value;
  for (const key of plan.containerPath) {
    const next: unknown = node?.[key];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) return null;
    node = next as Record<string, unknown>;
  }
  const out: Record<string, unknown> = {};
  for (const evName of Object.keys(plan.entries)) {
    const existing = node?.[evName];
    if (!Array.isArray(existing)) continue;
    const mine = existing.filter((x) => isUsewardenEntry(x));
    if (mine.length) out[evName] = mine;
  }
  return Object.keys(out).length ? out : null;
}

export function integrityHash(entries: unknown): string {
  return sha256(canonicalJson(entries));
}

/** Stable stringify: object keys sorted, so key reordering is not a false TAMPERED. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}';
}

export function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Applies the plan. Backups first, always. Returns the backup directory so the caller can print
 * the exact restore command.
 */
export function applyInit(changes: PlannedChange[], store: Store): InitResult {
  ensureHome();
  const errors: string[] = [];
  const real = changes.filter((c) => c.changed && !c.diff.startsWith('!!'));
  if (real.length === 0) {
    recordIntegrity(changes, store);
    return { changes, applied: false, errors };
  }

  const dir = path.join(backupsDir(), timestamp());
  mkdirpSafe(dir);

  // G1: every backup is on disk before the first config write.
  const manifest: Record<string, { backup: string | null; existed: boolean; sha256: string | null }> = {};
  for (const c of real) {
    const safe = c.configPath.replace(/[^A-Za-z0-9._-]/g, '_');
    if (c.before !== '' || fs.existsSync(c.configPath)) {
      const bfile = path.join(dir, safe);
      fs.writeFileSync(bfile, c.before, { mode: 0o600 });
      manifest[c.configPath] = { backup: safe, existed: true, sha256: sha256(c.before) };
    } else {
      // G7: the file did not exist. Record that fact so restore DELETES rather than recreates.
      manifest[c.configPath] = { backup: null, existed: false, sha256: null };
    }
    // G2: the diff is archived beside the backup even in non-interactive mode.
    fs.writeFileSync(path.join(dir, safe + '.diff'), c.diff + '\n', { mode: 0o600 });
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });

  for (const c of real) {
    try {
      mkdirpSafe(path.dirname(c.configPath), 0o755);
      fs.writeFileSync(c.configPath, c.after, { mode: 0o600 });
    } catch (e) {
      errors.push(`${c.configPath}: ${(e as Error).message}`);
    }
  }

  for (const c of real) {
    if (c.createdContainer) store.setMeta(createdContainerKey(c.configPath), '1');
  }
  store.setMeta('last_backup_dir', dir);
  recordIntegrity(changes, store);
  return { changes, applied: true, backupDir: dir, errors };
}

export function recordIntegrity(changes: PlannedChange[], store: Store): void {
  for (const c of changes) {
    if (c.diff.startsWith('!!')) continue;
    const entries = extractUsewardenEntries(c.configPath, c.agent);
    const rec: IntegrityRecord = {
      id: `hook:${c.agent}:${c.scope}:${c.configPath}`,
      kind: 'hook-entry',
      path: c.configPath,
      hash: integrityHash(entries),
      recordedAt: Date.now(),
    };
    store.putIntegrity(rec);
  }
}

export interface RestoreResult {
  dir: string;
  restored: { path: string; action: 'restored' | 'deleted'; byteIdentical: boolean }[];
  errors: string[];
}

export function latestBackupDir(): string | null {
  const b = backupsDir();
  if (!fs.existsSync(b)) return null;
  const dirs = fs.readdirSync(b).filter((d) => fs.existsSync(path.join(b, d, 'manifest.json'))).sort();
  const last = dirs[dirs.length - 1];
  return last ? path.join(b, last) : null;
}

/** Byte-identical restore, verified by re-hashing what was written (G5). */
export function restoreConfigs(dir?: string): RestoreResult {
  const d = dir ?? latestBackupDir();
  if (!d) return { dir: '', restored: [], errors: ['no backup found in ' + backupsDir()] };
  const manifestPath = path.join(d, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return { dir: d, restored: [], errors: [`no manifest.json in ${d}`] };
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as
    Record<string, { backup: string | null; existed: boolean; sha256: string | null }>;

  const out: RestoreResult = { dir: d, restored: [], errors: [] };
  for (const [configPath, m] of Object.entries(manifest)) {
    try {
      if (!m.existed) {
        if (fs.existsSync(configPath)) fs.rmSync(configPath);
        out.restored.push({ path: configPath, action: 'deleted', byteIdentical: !fs.existsSync(configPath) });
        continue;
      }
      const bytes = fs.readFileSync(path.join(d, m.backup!));
      mkdirpSafe(path.dirname(configPath), 0o755);
      fs.writeFileSync(configPath, bytes);
      const now = sha256(fs.readFileSync(configPath));
      out.restored.push({ path: configPath, action: 'restored', byteIdentical: now === m.sha256 });
    } catch (e) {
      out.errors.push(`${configPath}: ${(e as Error).message}`);
    }
  }
  return out;
}

/**
 * `usewarden uninstall` - surgically removes usewarden's entries rather than restoring a snapshot,
 * so any legitimate edits the user made since `init` survive. `restore-configs` is the
 * bigger hammer for when that is not what you want.
 */
export function uninstall(store: Store, projectRoot?: string): { removed: string[]; errors: string[] } {
  const removed: string[] = [];
  const errors: string[] = [];
  const known = store.listIntegrity().map((r) => r.path);
  for (const d of detectAllScopes(projectRoot, known)) {
    if (!fs.existsSync(d.configPath)) continue;
    try {
      if (d.format === 'plugin') {
        const content = fs.readFileSync(d.configPath, 'utf8');
        if (content.includes('Generated by usewarden')) {
          fs.rmSync(d.configPath);
          removed.push(d.configPath);
        }
        continue;
      }
      const f = readJsonFile(d.configPath);
      const before = f.raw;
      removeEntries(f, d.agent, store.getMeta(createdContainerKey(d.configPath)) === '1');
      const after = serialize(f);
      if (after !== before) {
        fs.writeFileSync(d.configPath, after);
        removed.push(d.configPath);
      }
    } catch (e) {
      errors.push(`${d.configPath}: ${(e as Error).message}`);
    }
  }
  store.clearIntegrity();
  store.setMeta('installed', 'false');
  return { removed, errors };
}

export function usewardenHomeInfo(): string { return usewardenHome(); }
export { isDirty, readJsonFile, serialize, previewDiff };
