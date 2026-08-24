import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

/**
 * GIT AWARENESS FOR LAYER 1 — "can git get this file back?"
 *
 * WHY THIS EXISTS. `scope.allowed_paths` allows every write inside the repository, which is what
 * makes usewarden usable and is also the hole the documented anthropics/claude-code#53900 incident
 * went through: an agent destroyed a file that was inside the project and had never been committed.
 * Scope cannot see the difference between overwriting a committed file — one `git checkout` away —
 * and overwriting one whose only copy is the bytes on disk.
 *
 * WHY IT READS GIT'S FILES INSTEAD OF RUNNING GIT. `docs/THREAT-MODEL.md` T-05 says usewarden never
 * constructs a subprocess from event data, and `tests/sabotage/suite.test.ts` greps `src/` for
 * `exec(`, `execSync` and `shell: true` to prove it. `git status --porcelain -- <path>` would put an
 * agent-supplied path on a command line on the hottest path in the product. So this module parses
 * `.git/index` and the ignore files directly, the way `currentBranch()` already reads `.git/HEAD`.
 *
 * IT FAILS OPEN, DELIBERATELY, AND THAT IS THE RIGHT DIRECTION HERE. Everything it cannot decide
 * returns 'unknown' and the caller does not fire. This guard's failure mode is a false positive on
 * ordinary work, and one false positive costs every future alert (docs/FALSE-POSITIVES.md). A miss
 * costs one file, which scope, the deny list and the checkpoint may still catch. The limits are
 * named in `docs/GIT-AWARENESS.md` rather than hidden: index v4, sha256 repositories, split index,
 * and `core.excludesFile` all return 'unknown'.
 */

export type GitFileState =
  /** Tracked, and the working tree matches what git has recorded. Recoverable. */
  | 'clean'
  /** Tracked, and the working tree differs from the index. The DIFFERENCE is unrecoverable. */
  | 'modified'
  /** Exists on disk, git has never seen it, and it is not ignored. Wholly unrecoverable. */
  | 'untracked'
  /** Matched an ignore rule. The user has declared this file is not work to preserve. */
  | 'ignored'
  /** Nothing at this path: creating a new file destroys nothing. */
  | 'absent'
  /** Not inside the repository, or there is no repository. Scope's problem, not this module's. */
  | 'outside'
  /** Could not be decided. Callers MUST treat this as "do not fire". */
  | 'unknown';

interface IndexEntry {
  mtimeSec: number;
  mtimeNsec: number;
  size: number;
  /** Object id of the staged content, hex. Used to settle a stat-dirty file by content. */
  oid: string;
}

/** Files larger than this are judged on stat alone rather than hashed on the hot path. */
const MAX_HASH_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * What git would say about one absolute path. Never spawns anything, never writes anything.
 */
export function gitFileState(abs: string, repoRoot: string): GitFileState {
  const rel = relativeInside(repoRoot, abs);
  if (rel === null) return 'outside';
  if (rel === '') return 'outside';

  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return 'absent';
  }
  // A directory is not a file whose contents can be lost by one write.
  if (!st.isFile()) return 'outside';

  const gitDir = resolveGitDir(repoRoot);
  if (!gitDir) return 'unknown';

  const index = parseGitIndex(gitDir);
  if (!index) return 'unknown';

  const entry = index.get(rel);
  if (!entry) return isIgnored(rel, repoRoot, gitDir) ? 'ignored' : 'untracked';

  // Cheap stat comparison first — this is what git itself does before reading any content.
  if (entry.size === st.size && sameMtime(entry, st)) return 'clean';

  // Stat-dirty is not the same as content-dirty: a rebuild, a `touch`, or a checkout can change
  // the stat without changing a byte, and reporting those as lost work would be a false positive
  // on the most ordinary action there is. Settle it against the recorded object id.
  if (st.size <= MAX_HASH_BYTES) {
    const oid = blobOid(abs, st.size);
    if (oid === null) return 'unknown';
    return oid === entry.oid ? 'clean' : 'modified';
  }
  return entry.size === st.size ? 'unknown' : 'modified';
}

/** True when git cannot restore this file's current contents from anything it has recorded. */
export function isUnrecoverable(state: GitFileState): boolean {
  return state === 'untracked' || state === 'modified';
}

// ---------------------------------------------------------------------------
// .git discovery
// ---------------------------------------------------------------------------

/**
 * The real git directory for a work tree, following the `gitdir:` pointer a worktree or a
 * submodule leaves behind. Same shape as the resolution `currentBranch()` does for HEAD.
 */
export function resolveGitDir(repoRoot: string): string | null {
  const dotGit = path.join(repoRoot, '.git');
  try {
    const st = fs.statSync(dotGit);
    if (st.isDirectory()) return dotGit;
    const text = fs.readFileSync(dotGit, 'utf8');
    const m = /^gitdir:\s*(.+)$/m.exec(text);
    if (!m) return null;
    const p = m[1]!.trim();
    return path.isAbsolute(p) ? p : path.resolve(repoRoot, p);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// .git/index
// ---------------------------------------------------------------------------

interface IndexCacheEntry {
  key: string;
  map: Map<string, IndexEntry> | null;
}
const indexCache = new Map<string, IndexCacheEntry>();

/** Drops every cached parse. Tests that mutate a repository in place call this. */
export function clearGitStateCache(): void {
  indexCache.clear();
  ignoreCache.clear();
  configCache.clear();
}

/**
 * Parses `.git/index` into path -> stat/oid. Returns null for anything it does not fully
 * understand, which the caller turns into "do not fire".
 *
 * Cached on the index file's own size and nanosecond mtime: git rewrites the whole file on every
 * change, so a matching key means a matching parse.
 */
export function parseGitIndex(gitDir: string): Map<string, IndexEntry> | null {
  const file = path.join(gitDir, 'index');
  let key: string;
  try {
    const st = fs.statSync(file, { bigint: true });
    key = `${st.size}:${st.mtimeNs}`;
  } catch (err) {
    /**
     * NO INDEX FILE IS A FACT, NOT A FAILURE — and the difference was found by the differential
     * test, not by reading this code.
     *
     * `git init` writes no index until something is staged, so a brand-new repository has none.
     * Returning null there made every file in it 'unknown', which is precisely where a first
     * session's writes land. An absent index means an EMPTY index: nothing is tracked. Any other
     * error still returns null, because "I could not read it" and "it says nothing" are different
     * sentences (CLAUDE.md section 4.4).
     */
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    return null;
  }
  const cached = indexCache.get(file);
  if (cached && cached.key === key) return cached.map;

  const map = readIndex(gitDir, file);
  // Bound the cache: a hook process is short-lived, but `usewarden scan` walks a whole project.
  if (indexCache.size > 32) indexCache.clear();
  indexCache.set(file, { key, map });
  return map;
}

function readIndex(gitDir: string, file: string): Map<string, IndexEntry> | null {
  // A sha256 repository stores 32-byte object ids, and a split index keeps most entries in a
  // shared file this parser never opens. Both are readable in principle and neither is decided
  // by guessing: bail, and let the caller not fire.
  const cfg = gitConfigText(gitDir);
  if (/objectformat\s*=\s*sha256/i.test(cfg)) return null;
  if (/splitindex\s*=\s*true/i.test(cfg)) return null;

  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return null;
  }
  if (buf.length < 12) return null;
  if (buf.toString('latin1', 0, 4) !== 'DIRC') return null;

  const version = buf.readUInt32BE(4);
  // v4 prefix-compresses every path against its predecessor and drops the padding. It is only
  // produced when a user asks for it, and misparsing it would silently mark tracked files
  // untracked — the exact direction that blocks ordinary work.
  if (version !== 2 && version !== 3) return null;

  const count = buf.readUInt32BE(8);
  // The index is bounded by the file: 62 bytes is the smallest an entry can be even before its
  // path, so a header claiming more entries than could fit is a corrupt or foreign file.
  if (count > (buf.length - 12) / 62) return null;

  const map = new Map<string, IndexEntry>();
  let off = 12;
  for (let i = 0; i < count; i++) {
    if (off + 62 > buf.length) return null;
    const mtimeSec = buf.readUInt32BE(off + 8);
    const mtimeNsec = buf.readUInt32BE(off + 12);
    const size = buf.readUInt32BE(off + 36);
    const oid = buf.toString('hex', off + 40, off + 60);
    const flags = buf.readUInt16BE(off + 60);
    let nameOff = off + 62;
    if (version >= 3 && (flags & 0x4000) !== 0) nameOff += 2; // extended flags

    let nameLen = flags & 0x0fff;
    if (nameLen === 0x0fff) {
      // The 12-bit field saturates; the real length is found by scanning to the terminator.
      const end = buf.indexOf(0, nameOff);
      if (end === -1) return null;
      nameLen = end - nameOff;
    }
    if (nameOff + nameLen > buf.length) return null;
    const name = buf.toString('utf8', nameOff, nameOff + nameLen);

    map.set(name, { mtimeSec, mtimeNsec, size, oid });

    // git pads each entry with 1..8 NUL bytes so the next one starts on an 8-byte boundary.
    const base = nameOff - off;
    off += (base + nameLen + 8) & ~7;
  }
  return map;
}

const configCache = new Map<string, { key: string; text: string }>();
function gitConfigText(gitDir: string): string {
  const file = path.join(gitDir, 'config');
  try {
    const st = fs.statSync(file, { bigint: true });
    const key = `${st.size}:${st.mtimeNs}`;
    const hit = configCache.get(file);
    if (hit && hit.key === key) return hit.text;
    const text = fs.readFileSync(file, 'utf8');
    if (configCache.size > 32) configCache.clear();
    configCache.set(file, { key, text });
    return text;
  } catch {
    return '';
  }
}

/**
 * git treats the recorded nanoseconds as meaningful only when it wrote them. Filesystems and
 * checkout paths that report 0 there are common enough that comparing them would call clean files
 * modified, so a zero on either side means "compare seconds only".
 */
function sameMtime(entry: IndexEntry, st: fs.Stats): boolean {
  const sec = Math.floor(st.mtimeMs / 1000);
  if (entry.mtimeSec !== sec) return false;
  if (entry.mtimeNsec === 0) return true;
  const nsec = Number((st.mtimeMs % 1000).toFixed(6)) * 1e6;
  return Math.abs(nsec - entry.mtimeNsec) < 1e6;
}

/** `sha1("blob <size>\0" + contents)` — git's object id for a file's working-tree contents. */
function blobOid(abs: string, size: number): string | null {
  try {
    const h = crypto.createHash('sha1');
    h.update(`blob ${size}\0`);
    h.update(fs.readFileSync(abs));
    return h.digest('hex');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// .gitignore
// ---------------------------------------------------------------------------

interface IgnoreRule {
  re: RegExp;
  negated: boolean;
  dirOnly: boolean;
}
const ignoreCache = new Map<string, { key: string; rules: IgnoreRule[] }>();

/**
 * Whether git would call `rel` ignored.
 *
 * AN IGNORED FILE IS NOT LOST WORK — the user has already said so in writing. Without this, a
 * guard on untracked files refuses to let an agent regenerate `dist/`, which is ordinary work and
 * exactly the over-guard the spec warns about (SPEC-BUILD 3A.6).
 *
 * Precedence follows git: `.git/info/exclude` first, then `.gitignore` from the repository root
 * downwards, last match winning. An ignored DIRECTORY ignores everything beneath it, so each
 * ancestor is tested as a directory before the file itself.
 *
 * Not implemented, and named in docs/GIT-AWARENESS.md: `core.excludesFile` (the user's global
 * ignore file) and `.git/info/sparse-checkout`. Both can only make this UNDER-report ignoredness,
 * which is the direction that fires — so anything they would have covered is caught by the
 * untracked check below being conservative about what it blocks.
 */
export function isIgnored(rel: string, repoRoot: string, gitDir: string): boolean {
  const parts = rel.split('/');
  let decided = false;

  // Each ancestor directory, then the file itself.
  for (let depth = 0; depth < parts.length; depth++) {
    const candidate = parts.slice(0, depth + 1).join('/');
    const isDir = depth < parts.length - 1;
    let verdict: boolean | null = null;

    // Sources apply in precedence order; within a source the last matching rule wins.
    const sources: IgnoreRule[][] = [readIgnoreFile(path.join(gitDir, 'info', 'exclude'), '')];
    for (let d = 0; d <= depth; d++) {
      const dir = parts.slice(0, d).join('/');
      sources.push(readIgnoreFile(path.join(repoRoot, dir, '.gitignore'), dir));
    }

    for (const rules of sources) {
      for (const r of rules) {
        if (r.dirOnly && !isDir) continue;
        if (r.re.test(candidate)) verdict = !r.negated;
      }
    }
    if (verdict === true) {
      // git does not descend into an ignored directory, so nothing below it can be un-ignored.
      if (isDir) return true;
      decided = true;
    } else if (verdict === false) {
      decided = false;
    }
  }
  return decided;
}

function readIgnoreFile(file: string, dirPrefix: string): IgnoreRule[] {
  let key: string;
  try {
    const st = fs.statSync(file, { bigint: true });
    key = `${st.size}:${st.mtimeNs}`;
  } catch {
    return [];
  }
  const hit = ignoreCache.get(file);
  if (hit && hit.key === key) return hit.rules;

  let rules: IgnoreRule[] = [];
  try {
    rules = fs.readFileSync(file, 'utf8').split(/\r?\n/)
      .map((line) => compileIgnoreLine(line, dirPrefix))
      .filter((r): r is IgnoreRule => r !== null);
  } catch {
    rules = [];
  }
  if (ignoreCache.size > 64) ignoreCache.clear();
  ignoreCache.set(file, { key, rules });
  return rules;
}

/**
 * One `.gitignore` line to a rule matched against a repository-root-relative path, or null for a
 * blank line or a comment. Follows gitignore(5): `!` negates, a trailing `/` means directory-only,
 * a `/` anywhere but the end anchors the pattern to the file's own directory, and a pattern with
 * no `/` matches a basename at any depth.
 */
export function compileIgnoreLine(raw: string, dirPrefix: string): IgnoreRule | null {
  let line = raw;
  // Trailing whitespace is not part of the pattern unless it was escaped.
  line = line.replace(/(?<!\\)\s+$/, '');
  if (line === '') return null;
  if (line.startsWith('#')) return null;

  let negated = false;
  if (line.startsWith('!')) { negated = true; line = line.slice(1); }
  else if (line.startsWith('\\#') || line.startsWith('\\!')) line = line.slice(1);
  if (line === '') return null;

  let dirOnly = false;
  if (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1); }
  if (line === '') return null;

  const anchored = line.includes('/');
  if (line.startsWith('/')) line = line.slice(1);

  const prefix = dirPrefix === '' ? '' : `${dirPrefix}/`;
  const body = globBody(line);
  const source = anchored
    ? `^${escapeLiteral(prefix)}${body}(?:/.*)?$`
    : `^(?:.*/)?${body}(?:/.*)?$`;
  try {
    return { re: new RegExp(source), negated, dirOnly };
  } catch {
    return null;
  }
}

function escapeLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** gitignore glob syntax to a regex body. `**` crosses directories; `*` and `?` do not. */
function globBody(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '\\' && i + 1 < glob.length) { out += escapeLiteral(glob[++i]!); continue; }
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; out += '(?:.*/)?'; }
        else out += '.*';
        continue;
      }
      out += '[^/]*';
      continue;
    }
    if (c === '?') { out += '[^/]'; continue; }
    if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end > i) {
        let cls = glob.slice(i + 1, end);
        if (cls.startsWith('!')) cls = `^${cls.slice(1)}`;
        out += `[${cls}]`;
        i = end;
        continue;
      }
      out += '\\[';
      continue;
    }
    out += escapeLiteral(c);
  }
  return out;
}

// ---------------------------------------------------------------------------

/** Repository-root-relative, `/`-separated path, or null when `abs` is not inside `repoRoot`. */
function relativeInside(repoRoot: string, abs: string): string | null {
  const rel = path.relative(path.resolve(repoRoot), path.resolve(abs));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return rel === '' ? '' : null;
  return rel.split(path.sep).join('/');
}
