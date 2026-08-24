import * as fs from 'node:fs';
import * as path from 'node:path';
import { usewardenHome, ensureHome } from './paths.js';
import { mkdirpSafe } from './util.js';

/**
 * `usewarden allow <rule-id>` — the escape hatch, with a fuse on it.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS IS THE HIGHEST-VALUE THING LEFT TO BUILD
 * ---------------------------------------------------------------------------------------------
 * `docs/FALSE-POSITIVES.md` names it as the single most likely cause of someone removing this
 * tool: a guardrail that blocks something legitimate and offers no way past it except editing a
 * policy file mid-task. The author has hit that himself repeatedly — `usewarden` has refused its
 * own maintainer writing documentation about dangerous commands five times in one day.
 *
 * Mature scanners solve this with inline suppression carrying a justification (`#nosec`,
 * `//nolint`). That does not transfer: a usewarden finding is an agent action at a moment, not a
 * line of source, so there is nowhere to put a comment.
 *
 * ---------------------------------------------------------------------------------------------
 * FOUR PROPERTIES, EACH OF WHICH IS THE REASON THE OTHERS ARE SAFE
 * ---------------------------------------------------------------------------------------------
 * 1. **It expires.** 24 hours, the founder's decision. A permanent exception is an allowlist entry,
 *    and this project's own history is that broad allowlist entries hide the next real finding
 *    (D-153, D-194). A forgotten exception heals by itself.
 *
 * 2. **It is not in the policy file.** It lives in the state directory, so it can never quietly
 *    become permanent by being committed, shared, or inherited by a teammate's checkout.
 *
 * 3. **It is scoped to one rule in one project.** `usewarden allow dotenv-access` in one repo does
 *    not open `.env` reads everywhere on the machine.
 *
 * 4. **THE AGENT CANNOT INVOKE IT.** This is the property the whole feature depends on, because an
 *    escape hatch an agent can operate is not a guardrail at all — it is a speed bump with a
 *    documented bypass. See `refuseIfNotHuman()`.
 *
 * A waived block is still RECORDED. The verdict becomes a warning naming the exception and its
 * expiry, an incident row is written, and it appears on the receipt. "Allowed because you said so"
 * and "allowed because nothing objected" must never render alike.
 */

/** The founder's decision, 2026-08-24. Long enough for one session, short enough to heal. */
export const DEFAULT_TTL_HOURS = 24;

export interface Exception {
  /** The rule id as it appears in an incident card, e.g. `dotenv-access` or `scope.allowed_paths`. */
  rule: string;
  /** Absolute repo root this applies to. An exception is never machine-wide. */
  scope: string;
  /** Epoch ms. */
  createdAt: number;
  expiresAt: number;
  /** Optional free-text note the human typed. */
  note?: string;
}

function file(): string {
  return path.join(usewardenHome(), 'exceptions.json');
}

export function loadExceptions(now = Date.now()): Exception[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((x): x is Exception => !!x && typeof x === 'object'
        && typeof (x as Exception).rule === 'string'
        && typeof (x as Exception).scope === 'string'
        && typeof (x as Exception).expiresAt === 'number')
      // EXPIRY IS ENFORCED ON READ, not by a cleanup job. A cleanup job that does not run leaves
      // a live exception behind; a read-time check cannot.
      .filter((x) => x.expiresAt > now);
  } catch {
    return [];
  }
}

/** Everything on disk, expired entries included, for the audit listing. */
export function loadAllExceptions(): Exception[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as unknown;
    return Array.isArray(raw) ? raw as Exception[] : [];
  } catch {
    return [];
  }
}

function save(list: Exception[]): void {
  ensureHome();
  mkdirpSafe(path.dirname(file()));
  fs.writeFileSync(file(), `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 });
}

export function addException(rule: string, scope: string, hours = DEFAULT_TTL_HOURS,
  note?: string, now = Date.now()): Exception {
  const ex: Exception = {
    rule,
    scope: path.resolve(scope),
    createdAt: now,
    expiresAt: now + hours * 3_600_000,
    ...(note ? { note } : {}),
  };
  // Expired entries are dropped as a side effect of writing, so the file cannot grow without bound.
  const keep = loadAllExceptions().filter((x) => x.expiresAt > now
    && !(x.rule === ex.rule && path.resolve(x.scope) === ex.scope));
  save([...keep, ex]);
  return ex;
}

export function revokeException(rule: string, scope: string, now = Date.now()): number {
  const target = path.resolve(scope);
  const all = loadAllExceptions().filter((x) => x.expiresAt > now);
  const keep = all.filter((x) => !(x.rule === rule && path.resolve(x.scope) === target));
  save(keep);
  return all.length - keep.length;
}

/**
 * The exception covering this rule in this project, or null.
 *
 * A rule id on an incident card carries an index and a name — `commands.deny[6] (dotenv-access)` —
 * and a human types the NAME. Both forms match, because asking someone to retype
 * `commands.deny[6]` correctly under time pressure is asking them to give up.
 */
export function findException(rule: string, repoRoot: string | undefined,
  list: readonly Exception[]): Exception | null {
  if (!repoRoot) return null;
  const root = path.resolve(repoRoot);
  for (const x of list) {
    if (path.resolve(x.scope) !== root) continue;
    if (ruleMatches(x.rule, rule)) return x;
  }
  return null;
}

/**
 * Does a typed rule id cover an actual verdict's rule id?
 *
 * THREE FORMS APPEAR ON INCIDENT CARDS AND A HUMAN TYPES WHICHEVER THEY REMEMBER:
 *
 *   commands.deny[6] (dotenv-access)      an indexed rule with a name
 *   scope.forbidden_paths[11]             an indexed rule with no name
 *   scope.protect_uncommitted (untracked) a named refinement of a section
 *
 * Found by the first end-to-end test: granting `scope.forbidden_paths` did not cover
 * `scope.forbidden_paths[11]`, so the waiver silently did nothing and the user would have
 * concluded the feature was broken. A waiver that appears to be granted and is not is worse than
 * no waiver at all.
 *
 * So a typed id matches when it equals the verdict's id, its parenthesised name, or the section
 * the verdict belongs to once the `[N]` index and any ` (name)` suffix are stripped. Matching is
 * deliberately NOT a prefix test: `scope.forbidden` must not waive `scope.forbidden_paths`.
 */
export function ruleMatches(typed: string, actual: string): boolean {
  if (typed === actual) return true;
  const name = /\(([^)]+)\)\s*$/.exec(actual)?.[1];
  if (name && typed === name) return true;
  const section = actual.replace(/\s*\([^)]*\)\s*$/, '').replace(/\[\d+\]$/, '');
  return typed === section;
}

/**
 * REFUSE TO RUN FOR ANYTHING THAT IS NOT A PERSON AT A TERMINAL.
 *
 * The entire feature rests on this. An escape hatch an agent can operate is not a guardrail, it is
 * a documented bypass — and an agent that has just been blocked has every incentive to try, because
 * "work around the obstacle" is what it is optimised to do.
 *
 * The signal is an interactive stdin. Every agent in `docs/HOOK-MATRIX.md` runs shell commands
 * through a captured pipe, not a pty: that is how they read the output back. So `isTTY` is false
 * for a tool-invoked command and true for a person typing. It is not a cryptographic boundary and
 * is not claimed as one — an agent that allocated a pty could defeat it. It is the difference
 * between "cannot be done by accident in the course of a session" and "is a one-line workaround the
 * model will find on its first attempt", and that difference is the whole value.
 *
 * `USEWARDEN_ALLOW_NONINTERACTIVE=1` exists for the test suite and for a human scripting their own
 * machine deliberately. It is documented, not hidden, because an undocumented override is one a
 * user cannot audit — and because pretending it does not exist would not stop anyone reading the
 * source.
 */
export function refuseIfNotHuman(): string | null {
  if (process.env['USEWARDEN_ALLOW_NONINTERACTIVE'] === '1') return null;
  if (process.stdin.isTTY === true) return null;
  return 'usewarden allow must be run by a person at a terminal, not by an agent.\n'
    + '  stdin is not interactive, which is how every supported agent runs a shell command.\n'
    + '  If you are the human and you are scripting this deliberately, set\n'
    + '  USEWARDEN_ALLOW_NONINTERACTIVE=1 — and read docs/FALSE-POSITIVES.md first.';
}

/** How long is left, in words. */
export function remaining(ex: Exception, now = Date.now()): string {
  const ms = ex.expiresAt - now;
  if (ms <= 0) return 'expired';
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m left`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m left`;
}
