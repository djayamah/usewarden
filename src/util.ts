import { createHash } from 'node:crypto';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

/**
 * FIRST STATEMENT of every process entrypoint.
 * Node emits `ExperimentalWarning: SQLite is an experimental feature` on stderr on some
 * versions (measured: v25.5.0 yes, v22.22.0 no — DECISIONS.md D-003). Agents surface hook
 * stderr as the block reason, and Gemini CLI's contract is stdout purity, so an unsolicited
 * warning is a correctness bug, not cosmetics.
 */
export function silenceNodeWarnings(): void {
  process.removeAllListeners('warning');
}

/**
 * A `mkdir -p` that CANNOT HANG.
 *
 * Node's `fs.mkdirSync(p, { recursive: true })` blocks forever when the target sits on procfs -
 * measured on Linux, where `mkdirSync("/proc/x/y", { recursive: true })` never returns while the
 * non-recursive form fails instantly with ENOENT. That is a platform quirk, but the consequence
 * for usewarden is the worst kind of failure it can have: the hook runs inside the agent's
 * critical path, a blocked hook is a blocked agent, and the whole promise of this tool is that it
 * fails OPEN. It hung a CI job for fifteen minutes before it hung anything else.
 *
 * A timer cannot rescue this - the block is inside a synchronous syscall, so no watchdog in this
 * process would ever get a turn. The fix is therefore to never make the call that can block:
 * walk up to the nearest EXISTING ancestor with `statSync` (which returns immediately even on
 * procfs), check it is a writable directory, and then create the missing components one at a
 * time with the non-recursive form (which fails fast).
 *
 * Throws a normal Error on failure. Callers that must not fail hard already wrap this.
 */
export function mkdirpSafe(target: string, mode = 0o700): void {
  const abs = path.resolve(target);

  // Virtual filesystems are never a legitimate home for state, and naming them produces a far
  // better message than "operation failed".
  for (const vfs of ['/proc', '/sys', '/dev']) {
    if (abs === vfs || abs.startsWith(vfs + path.sep)) {
      throw new Error(`refusing to create ${abs}: ${vfs} is a virtual filesystem, not a place for state`);
    }
  }

  // Find the nearest existing ancestor, collecting what has to be created.
  const missing: string[] = [];
  let cur = abs;
  for (;;) {
    let st: fs.Stats | undefined;
    try { st = fs.statSync(cur); } catch { st = undefined; }
    if (st) {
      if (!st.isDirectory()) throw new Error(`refusing to create ${abs}: ${cur} exists and is not a directory`);
      break;
    }
    missing.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) throw new Error(`refusing to create ${abs}: reached the filesystem root without finding an existing directory`);
    cur = parent;
    if (missing.length > 64) throw new Error(`refusing to create ${abs}: path is implausibly deep`);
  }

  fs.accessSync(cur, fs.constants.W_OK);   // throws EACCES fast, rather than failing halfway up

  for (const dir of missing.reverse()) {
    try {
      fs.mkdirSync(dir, { mode });
    } catch (e) {
      // A concurrent creator winning the race is success, not failure.
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
}

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function nowMs(): number {
  return Date.now();
}

/** Expand a leading `~` against the real home dir, then resolve to an absolute path. */
export function resolveUserPath(p: string, base?: string): string {
  let s = p;
  if (s === '~') s = os.homedir();
  else if (s.startsWith('~/')) s = path.join(os.homedir(), s.slice(2));
  return path.resolve(base ?? process.cwd(), s);
}

/**
 * Collapse the user's home directory to `~` for DISPLAY ONLY.
 *
 * The dashboard and the incident cards are the two things people screenshot and paste into
 * issues, Slack and Twitter, and an absolute path carries the operator's account name with it.
 * A tool whose whole pitch is "it does not exfiltrate your paths" should not print them into
 * every screenshot either. Never use this for comparison, storage, or any scope decision -
 * `isInside()` and the policy layer always work on resolved absolute paths.
 */
export function displayPath(s: string): string {
  const home = os.homedir();
  if (!home || home === '/' ) return s;
  // Replace every occurrence, not just a prefix: an incident's `attempted` is a whole command
  // line and can carry several absolute paths.
  return s.split(home + path.sep).join('~' + path.sep).split(home).join('~');
}

/**
 * True iff `child` is inside `parent` (or equal). Both are resolved first, so
 * `../` and symlink-free traversal cannot escape. Used for every scope decision.
 */
export function isInside(parent: string, child: string): boolean {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  if (c === p) return true;
  const rel = path.relative(p, c);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Minimal glob → RegExp. Supports `**`, `*`, `?`, and a literal everything else. */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**/` swallows the slash so `a/**/b` also matches `a/b`
        if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2; }
        else { out += '.*'; i += 1; }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + out + '$');
}

export function matchesAnyGlob(p: string, globs: readonly string[], base: string): boolean {
  const abs = path.resolve(p);
  for (const g of globs) {
    const expanded = resolveUserPath(g, base);
    if (globToRegExp(expanded).test(abs)) return true;
    // A bare directory in the list means "that directory and everything under it".
    if (!g.includes('*') && isInside(expanded, abs)) return true;
  }
  return false;
}

/**
 * Redact anything that looks like a credential before it is logged, stored, or judged.
 *
 * This runs on every incident row, every judge payload, and every log line, so a gap here is a
 * credential in a database, on a dashboard, or in a third party's model context.
 *
 * TWO MECHANISMS, on purpose. Pattern matching alone was not enough and this repository has the
 * scar to prove it: on 2026-08-20 Google was found to be issuing Gemini keys in a NEW format -
 * `AQ.` plus 50 characters - and the pattern list only knew the legacy `AIza` shape, so a live
 * key from a user who signed up that week passed straight through untouched. Google publishes no
 * key-format specification, so any list of prefixes is a guess with a shelf life. Adding `AQ.`
 * and stopping would repeat exactly the mistake D-081 records for the .env reader denylist.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bnpm_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Google, legacy: AIza + 35. Google, current: AQ. + ~50. Both are in the wild simultaneously -
  // an existing key keeps working while new ones are issued in the new shape.
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bAQ\.[A-Za-z0-9_-]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b[A-Z_][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\s*=\s*\S+/g,
];

/** Environment variables whose VALUE is a live credential on this machine. */
const CREDENTIAL_ENV_VARS = [
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY',
  'GOOGLE_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
] as const;

/** Shortest string treated as a credential. Below this, an exact-match strip would be reckless. */
const MIN_CREDENTIAL_LEN = 16;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Strips the EXACT value of any credential this process was configured with.
 *
 * Redaction by identity rather than by shape. It cannot be defeated by a vendor changing its key
 * format, because it never assumes one: if the key is in the environment, usewarden already
 * knows the precise string to remove, whatever it looks like. That makes it the backstop the
 * pattern list is not - the `AQ.` miss above would have been caught by this even with no pattern
 * for it at all.
 *
 * It only ever REMOVES. There is no path here that writes, logs, or returns a key.
 */
export function redactConfiguredSecrets(text: string): string {
  let out = text;
  for (const name of CREDENTIAL_ENV_VARS) {
    const value = process.env[name]?.trim();
    if (!value || value.length < MIN_CREDENTIAL_LEN) continue;
    out = out.replace(new RegExp(escapeRegExp(value), 'g'), '[REDACTED]');
  }
  return out;
}

export function redact(text: string): string {
  let out = redactConfiguredSecrets(text);
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

/** Truncate for display without splitting an escape sequence mid-way. */
export function ellipsis(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/**
 * Collapses a multi-line command into one display line.
 *
 * Real agents write heredocs, and a raw newline inside an incident card tears the frame apart -
 * which was observed on a live catch. Newlines become a visible pilcrow so the reader can still
 * see that the original was multi-line.
 */
export function oneLine(s: string): string {
  return s.replace(/\r/g, '').replace(/\n+/g, ' \u00b6 ').replace(/[ \t]{2,}/g, ' ').trim();
}
