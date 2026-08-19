import { createHash } from 'node:crypto';
import * as path from 'node:path';
import * as os from 'node:os';

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

/** Redact anything that looks like a credential before it is logged, stored, or judged. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bnpm_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b[A-Z_][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\s*=\s*\S+/g,
];

export function redact(text: string): string {
  let out = text;
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
