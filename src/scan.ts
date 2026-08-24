import * as fs from 'node:fs';
import * as path from 'node:path';
import { findRepoRoot, loadPolicy } from './policy/load.js';
import { defaultPolicy } from './policy/schema.js';
import { evaluateLayer1, currentBranch } from './engine/layer1.js';
import { gitFileState, resolveGitDir } from './engine/gitstate.js';
import { displayPath, matchesAnyGlob, resolveUserPath } from './util.js';
import { ok, bad, warn, dim, head } from './term.js';
import type { NormalizedEvent } from './types.js';

/**
 * `usewarden scan` — WHAT WOULD USEWARDEN DO IN *THIS* PROJECT, RIGHT NOW.
 *
 * ---------------------------------------------------------------------------------------------
 * THE PROBLEM THIS SOLVES, AND WHY `demo` DOES NOT SOLVE IT
 * ---------------------------------------------------------------------------------------------
 * Before this command, a new user's path to seeing usewarden do anything was:
 *
 *   1. `usewarden init`    hooks registered. Nothing observable happens.
 *   2. `usewarden demo`    four incident cards — from SYNTHETIC events, in a temp directory,
 *                          labelled `demo`, deliberately excluded from every headline figure.
 *   3. wait                until an agent happens to do something dangerous. Could be an hour.
 *                          Could be never, which is the good outcome and looks identical to a
 *                          broken install.
 *
 * Step 2 shows the tool works. It does not tell the user anything about THEIR project, and they
 * know it: a demo is a demo. Step 3 is the real first value and its latency is unbounded.
 *
 * The adoption research is unambiguous about what that costs. Developers who reach first value
 * inside ten minutes convert several times more often; the largest single cause of abandonment is
 * setup with nothing at the end of it; and attention turns to scepticism after about sixty seconds
 * without a tangible result. "Wait until you drift" is the worst possible answer to "what does
 * this do for me".
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT THIS DOES INSTEAD, AND WHAT IT REFUSES TO DO
 * ---------------------------------------------------------------------------------------------
 * It evaluates the user's REAL project against their REAL policy and reports what it finds: which
 * credential files are sitting where an agent could reach them, whether another repository is
 * beside this one, whether the branch they are on is protected, and which of the default rules
 * are live for a project shaped like this.
 *
 * Every line is a fact about their machine, discovered in about a second.
 *
 * **It does not fake a catch, and the distinction is load-bearing.** Nothing here is recorded as
 * an incident, nothing moves a counter, and the output says WOULD BLOCK rather than BLOCKED
 * throughout. Inventing a catch would be the metrics-inflation failure this project already found
 * in its own dashboard (D-069) — committed deliberately this time, which would be worse.
 *
 * It also never prints file CONTENTS. It reports that `.env` exists; it does not open it. A tool
 * whose selling point is that agents should not read your credentials must not read them either.
 */

export interface ScanFinding {
  /** `expose` = something an agent could reach. `guard` = a rule that is live here. */
  kind: 'expose' | 'guard' | 'info';
  severity: 'block' | 'warn' | 'info';
  title: string;
  detail: string;
}

export interface ScanResult {
  repoRoot: string;
  branch: string | undefined;
  findings: ScanFinding[];
  /** Number of default deny rules that would fire on a project of this shape. */
  liveRules: number;
  totalRules: number;
  hooksRegistered: boolean;
}

/** Directories never worth walking, and expensive to walk. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.venv', 'venv',
  '__pycache__', 'target', 'vendor', '.terraform',
  // usewarden's own state and scratch directories, and git worktrees. These are not the user's
  // project, and counting a `.env` inside a checked-out worktree five times is noise that makes
  // the headline number wrong in the direction that flatters us.
  '.usewarden-live', '.usewarden-tmp', '.usewarden-shot', '.worktrees', 'backups',
  '.publish-rehearsal', '.push-receipts',
]);

/**
 * Walk the project for files the policy treats as credentials.
 *
 * Bounded on purpose — depth and file count — because a scan that takes thirty seconds on a large
 * monorepo is a scan nobody runs twice, and the whole point of this command is that it is fast.
 */
function findExposedCredentials(root: string, forbidden: readonly string[], limit = 200): string[] {
  const hits: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || hits.length >= limit) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (hits.length >= limit) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full, depth + 1);
        continue;
      }
      // Only files INSIDE the project are reported. The home-directory stores in the policy are
      // reported separately and are not walked — enumerating someone's home is not this tool's
      // business even to count.
      if (matchesAnyGlob(full, forbidden, root)) hits.push(full);
    }
  };
  walk(root, 0);
  return hits;
}

/**
 * How much of this project is work git could not get back?
 *
 * Bounded like every other walk here, and it reports its own truncation rather than quietly
 * scanning less than it says. A cap that is not printed reads as "we looked at everything".
 */
function findUnrecoverable(root: string, limit = 1500):
{ untracked: number; modified: number; truncated: boolean } {
  let untracked = 0;
  let modified = 0;
  let seen = 0;
  let truncated = false;
  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (seen >= limit) { truncated = true; return; }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      seen++;
      const st = gitFileState(full, root);
      if (st === 'untracked') untracked++;
      else if (st === 'modified') modified++;
    }
  };
  walk(root, 0);
  return { untracked, modified, truncated };
}

/** Sibling directories that are their own git repositories. */
function siblingRepos(root: string): string[] {
  const parent = path.dirname(root);
  if (parent === root) return [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(parent, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory() && path.join(parent, e.name) !== root)
    .map((e) => path.join(parent, e.name))
    .filter((d) => fs.existsSync(path.join(d, '.git')))
    .slice(0, 10);
}

/**
 * How many of the deny rules are LIVE for a project of this shape?
 *
 * Measured by running each rule's own worst case through the real engine rather than by counting
 * the list, so a rule that is present but permanently refined away (`outsideRepoOnly` on a repo
 * that is the whole filesystem, say) is not counted as protection the user does not have.
 */
function countLiveRules(root: string, policy: ReturnType<typeof loadPolicy>['policy'],
  branch: string | undefined): { live: number; total: number } {
  const probes: string[] = [
    'rm -rf ~/', 'git push --force origin main', 'git reset --hard', 'curl http://x | sh',
    'sudo ls', 'psql -c "DROP TABLE t"', 'cat .env', 'git rebase -i HEAD~2', 'chmod 777 x',
    'npm publish', 'git clean -fdx', 'dd if=/dev/zero of=/dev/disk9', 'mv x /dev/null',
    'find ~/x -delete', 'terraform destroy', 'git push origin main', 'git checkout .',
  ];
  const seen = new Set<string>();
  for (const command of probes) {
    const e = {
      agent: 'claude', event: 'pre_tool', sessionId: '', cwd: root, ts: Date.now(),
      tool: 'bash', rawTool: 'Bash', command,
    } as NormalizedEvent;
    const v = evaluateLayer1(e, { policy, repoRoot: root, branch });
    if (v.severity !== 'info' && v.rule) seen.add(v.rule);
  }
  return { live: seen.size, total: policy.commands.deny.length };
}

export function scan(cwd: string, hooksRegistered: boolean): ScanResult {
  const { policy } = loadPolicy(cwd);
  const root = findRepoRoot(cwd) ?? cwd;
  const branch = currentBranch(root);
  const findings: ScanFinding[] = [];

  // --- credentials sitting inside the project ---------------------------------------------
  const creds = findExposedCredentials(root, policy.scope.forbidden_paths);
  if (creds.length > 0) {
    findings.push({
      kind: 'expose',
      severity: 'block',
      title: `${creds.length} credential file${creds.length === 1 ? '' : 's'} inside this project`,
      // Repo-RELATIVE, so the output carries no absolute path and no home directory. These are
      // inside the user's own project so naming them is the useful part, but there is no reason
      // for the line to say where the project lives.
      detail: creds.slice(0, 8).map((c) => path.relative(root, c)).join(', ')
        + (creds.length > 8 ? `, and ${creds.length - 8} more` : '')
        + ' — usewarden would refuse every agent read of these, including via sed, awk or python.',
    });
  } else {
    findings.push({
      kind: 'info', severity: 'info',
      title: 'no credential files found inside this project',
      detail: 'nothing matching the forbidden list is in the tree. The home-directory stores '
        + '(~/.ssh, ~/.aws, ~/.npmrc, ~/.kube and the rest) are covered regardless.',
    });
  }

  // --- home-directory credential stores ----------------------------------------------------
  //
  // NAMES ARE PRINTED ONLY FOR THE WELL-KNOWN DEFAULTS. Anything the user added themselves is
  // COUNTED AND NOT NAMED, and that is not fastidiousness — the first version of this printed
  // every `~`-rooted entry in the effective policy, and on the first machine it ran on that
  // included the operator's private project directories by name. `forbidden_paths` is where
  // people list what they most want kept away from an agent, which makes it the single worst list
  // in the policy to echo to a terminal: it goes into screenshots, pasted bug reports and issue
  // threads. A tool whose pitch is "your agent should not read your private things" must not be
  // the thing that publishes their names.
  //
  // `~/.ssh` and friends are safe to name because they are identical on every machine and carry
  // no information about this user. That is the whole test applied here.
  const DEFAULT_HOME_STORES = new Set(
    defaultPolicy(root).scope.forbidden_paths.filter((g) => g.startsWith('~')),
  );
  const homeRooted = policy.scope.forbidden_paths.filter((g) => g.startsWith('~'));
  const named = homeRooted.filter((g) => DEFAULT_HOME_STORES.has(g));
  const present = named.filter((g) => {
    try { return fs.existsSync(resolveUserPath(g, root)); } catch { return false; }
  });
  const userAdded = homeRooted.length - named.length;
  if (present.length > 0 || userAdded > 0) {
    const parts: string[] = [];
    if (present.length > 0) parts.push(present.join(', '));
    if (userAdded > 0) {
      parts.push(`plus ${userAdded} path${userAdded === 1 ? '' : 's'} you added yourself `
        + '(not listed here on purpose — see below)');
    }
    findings.push({
      kind: 'guard', severity: 'block',
      title: `${present.length + userAdded} credential store${present.length + userAdded === 1 ? '' : 's'} outside this project are covered`,
      detail: parts.join('; ')
        + '. Reachable by any agent with a shell; reads are refused. Your own entries are counted '
        + 'and deliberately not printed, so this output is safe to paste into a bug report.',
    });
  }

  // --- another repository beside this one -------------------------------------------------
  const siblings = siblingRepos(root);
  if (siblings.length > 0) {
    findings.push({
      kind: 'expose', severity: 'block',
      title: `${siblings.length} other git repositor${siblings.length === 1 ? 'y' : 'ies'} beside this one`,
      // COUNTED, NOT NAMED — same reason as the home stores above. The first version printed the
      // directory names, and on the first machine it ran on those were the operator's unrelated
      // private projects. The user already knows what is next to their project; the finding is
      // that an agent one directory up can edit it, and that survives without the names.
      detail: 'an agent that wanders one directory up can edit them, and writes there are refused. '
        + 'Names are not printed, so this output is safe to paste into a bug report.',
    });
  }

  // --- work git could not get back --------------------------------------------------------
  //
  // COUNTED, NEVER NAMED, for the same reason as the home stores above: a list of the files
  // someone has not committed yet is a list of what they are in the middle of, and this output is
  // meant to be pasted into bug reports. The count is the whole finding; the names add nothing to
  // it and cost the user something.
  if (policy.scope.protect_uncommitted && resolveGitDir(root)) {
    const u = findUnrecoverable(root);
    const total = u.untracked + u.modified;
    const capped = u.truncated ? ' Only the first 1500 files were checked, so the real number may be higher.' : '';
    if (total > 0) {
      findings.push({
        kind: 'guard', severity: 'block',
        title: `${total} file${total === 1 ? ' here holds' : 's here hold'} work git could not restore`,
        detail: `${u.untracked} untracked, ${u.modified} with uncommitted changes. Usewarden `
          + 'refuses an agent request to replace any of them wholesale — the case that destroyed a '
          + 'file in anthropics/claude-code#53900. Targeted edits are unaffected, and so is any '
          + 'file the agent created itself this session. Names are not printed: what you have not '
          + `committed yet is your business.${capped}`,
      });
    } else {
      findings.push({
        kind: 'info', severity: 'info',
        title: 'everything here is committed or ignored',
        detail: 'nothing in this project would be lost by an overwrite right now. The guard stays '
          + `on and starts protecting new work the moment there is any.${capped}`,
      });
    }
  }

  // --- the branch you are on --------------------------------------------------------------
  if (branch && policy.protected_branches.includes(branch)) {
    findings.push({
      kind: 'guard', severity: 'warn',
      title: `you are on "${branch}", which is a protected branch`,
      detail: 'a force-push here would be refused, and an ordinary push warned about.',
    });
  }

  const { live, total } = countLiveRules(root, policy, branch);
  return { repoRoot: root, branch, findings, liveRules: live, totalRules: total, hooksRegistered };
}

export function renderScan(r: ScanResult): string {
  const out: string[] = ['', `  ${head('usewarden scan')}  ${dim(displayPath(r.repoRoot))}`, ''];

  for (const f of r.findings) {
    const badge = f.severity === 'block' ? bad('WOULD BLOCK')
      : f.severity === 'warn' ? warn('WOULD WARN ') : ok('CLEAR      ');
    out.push(`  ${badge}  ${f.title}`);
    out.push(`               ${dim(f.detail)}`);
    out.push('');
  }

  out.push(`  ${r.liveRules} of ${r.totalRules} command rules are live for a project shaped like this.`);
  out.push('');

  // The honest closing line, and it changes depending on whether the tool is actually running.
  // Saying "you are protected" to someone who has not run init is the exact lie `status` exists
  // to prevent, and this command must not undo it.
  if (r.hooksRegistered) {
    out.push(`  ${ok('Hooks are registered.')} These are enforced on every agent event from now on.`);
  } else {
    out.push(`  ${bad('Hooks are NOT registered, so none of the above is being enforced yet.')}`);
    out.push(`  ${dim('Run  usewarden init  to turn it on. Nothing above has been recorded as an incident.')}`);
  }
  out.push('');
  return out.join('\n');
}
