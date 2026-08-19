import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseYaml, YamlError } from './yaml.js';
import { defaultPolicy, PolicyError, validatePolicy, type Policy } from './schema.js';
import { globalPolicyPath, usewardenHome } from '../paths.js';
import { mkdirpSafe, resolveUserPath, sha256 } from '../util.js';

export interface LoadedPolicy {
  policy: Policy;
  /** Files that contributed, in application order. */
  sources: string[];
  /** sha256 of each source file's bytes, for the self-integrity check (THREAT-MODEL T-07). */
  hashes: Record<string, string>;
  /** Non-fatal notices to surface to the user, e.g. a refused widening. */
  notices: PolicyNotice[];
}

export interface PolicyNotice {
  code: 'POLICY_WIDENING_REFUSED' | 'POLICY_UNTRUSTED_IGNORED';
  detail: string;
}

export class PolicyLoadError extends Error {
  constructor(readonly file: string, readonly detail: string) {
    super(`POLICY_INVALID: ${file}\n  ${detail}`);
    this.name = 'PolicyLoadError';
  }
}

function trustFile(): string { return path.join(usewardenHome(), 'trusted-policies.txt'); }

export function isTrusted(repoPolicyPath: string): boolean {
  const f = trustFile();
  if (!fs.existsSync(f)) return false;
  const abs = path.resolve(repoPolicyPath);
  return fs.readFileSync(f, 'utf8').split('\n').map((l) => l.trim()).includes(abs);
}

export function trust(repoPolicyPath: string): void {
  const abs = path.resolve(repoPolicyPath);
  const f = trustFile();
  mkdirpSafe(path.dirname(f));
  const existing = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  if (existing.split('\n').map((l) => l.trim()).includes(abs)) return;
  fs.writeFileSync(f, existing + (existing.endsWith('\n') || existing === '' ? '' : '\n') + abs + '\n', { mode: 0o600 });
}

export function untrust(repoPolicyPath: string): void {
  const abs = path.resolve(repoPolicyPath);
  const f = trustFile();
  if (!fs.existsSync(f)) return;
  const kept = fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim() !== abs && l.trim() !== '');
  fs.writeFileSync(f, kept.length ? kept.join('\n') + '\n' : '', { mode: 0o600 });
}

function parseFile(file: string, base: Policy): Policy {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new PolicyLoadError(file, `cannot read: ${(e as Error).message}`);
  }
  let doc;
  try {
    doc = parseYaml(text);
  } catch (e) {
    if (e instanceof YamlError) throw new PolicyLoadError(file, e.message);
    throw new PolicyLoadError(file, (e as Error).message);
  }
  try {
    return validatePolicy(doc, base);
  } catch (e) {
    if (e instanceof PolicyError) throw new PolicyLoadError(file, e.message);
    throw new PolicyLoadError(file, (e as Error).message);
  }
}

/**
 * Loads the effective policy for `cwd`.
 *
 * Order: built-in defaults -> `~/.usewarden/usewarden.yaml` (the user's own, trusted) ->
 * `<repo>/usewarden.yaml` (UNTRUSTED unless explicitly trusted).
 *
 * The repo layer may only NARROW the user's policy (docs/THREAT-MODEL.md T-06). Concretely:
 *   - `scope.allowed_paths` is intersected, never unioned;
 *   - `scope.forbidden_paths` and `commands.deny` and `protected_branches` are unioned (adding
 *     restrictions is always allowed; removing them is not);
 *   - `invariants` are unioned;
 *   - scalar toggles may only move in the restrictive direction.
 * Every refused widening is recorded as a notice and surfaces as an incident at evaluation time.
 */
export function loadPolicy(cwd: string): LoadedPolicy {
  const repoRoot = findRepoRoot(cwd) ?? path.resolve(cwd);
  let policy = defaultPolicy(repoRoot);
  const sources: string[] = ['<built-in defaults>'];
  const hashes: Record<string, string> = {};
  const notices: PolicyNotice[] = [];

  const g = globalPolicyPath();
  if (fs.existsSync(g)) {
    policy = parseFile(g, policy);
    sources.push(g);
    hashes[g] = sha256(fs.readFileSync(g));
  }
  const userLayer = structuredClone(policy);

  const repoPolicy = path.join(repoRoot, 'usewarden.yaml');
  if (fs.existsSync(repoPolicy) && path.resolve(repoPolicy) !== path.resolve(g)) {
    const trusted = isTrusted(repoPolicy);
    const candidate = parseFile(repoPolicy, policy);
    policy = trusted ? candidate : narrowOnly(userLayer, candidate, repoRoot, notices);
    sources.push(trusted ? `${repoPolicy} (trusted)` : `${repoPolicy} (untrusted, narrowing only)`);
    hashes[repoPolicy] = sha256(fs.readFileSync(repoPolicy));
  }

  return { policy, sources, hashes, notices };
}

/** Merge `repo` over `user` allowing only restrictions. */
function narrowOnly(user: Policy, repo: Policy, repoRoot: string, notices: PolicyNotice[]): Policy {
  const out: Policy = structuredClone(user);

  // allowed_paths: intersect. A repo may confine usewarden further, never open it up.
  const userAllowed = user.scope.allowed_paths.map((p) => resolveUserPath(p, repoRoot));
  const repoAllowed = repo.scope.allowed_paths.map((p) => resolveUserPath(p, repoRoot));
  const kept = repoAllowed.filter((p) => userAllowed.some((u) => p === u || p.startsWith(u + path.sep)));
  const dropped = repoAllowed.filter((p) => !kept.includes(p));
  if (dropped.length > 0) {
    notices.push({
      code: 'POLICY_WIDENING_REFUSED',
      detail: `repo usewarden.yaml tried to add allowed_paths outside your global scope: ${dropped.join(', ')}. Ignored. Run "usewarden trust ${path.join(repoRoot, 'usewarden.yaml')}" if you really mean it.`,
    });
  }
  if (kept.length > 0) out.scope.allowed_paths = kept;

  // forbidden_paths / protected_branches / invariants: union (adding restrictions is fine).
  out.scope.forbidden_paths = unionStrings(user.scope.forbidden_paths, repo.scope.forbidden_paths);
  out.protected_branches = unionStrings(user.protected_branches, repo.protected_branches);
  out.invariants = unionStrings(user.invariants, repo.invariants);

  // commands.deny: union by id; a repo may ADD rules but never delete or weaken one.
  const byId = new Map(user.commands.deny.map((r) => [r.id, r]));
  const removed: string[] = [];
  for (const [id] of byId) {
    if (!repo.commands.deny.some((r) => r.id === id)) removed.push(id);
  }
  for (const r of repo.commands.deny) {
    const existing = byId.get(r.id);
    if (!existing) { byId.set(r.id, r); continue; }
    if (existing.action === 'block' && r.action === 'warn') {
      notices.push({
        code: 'POLICY_WIDENING_REFUSED',
        detail: `repo usewarden.yaml tried to downgrade command rule "${r.id}" from block to warn. Ignored.`,
      });
      continue;
    }
    byId.set(r.id, r);
  }
  if (removed.length > 0) {
    notices.push({
      code: 'POLICY_WIDENING_REFUSED',
      detail: `repo usewarden.yaml omitted command rules that your global policy defines: ${removed.join(', ')}. They stay enforced.`,
    });
  }
  out.commands.deny = [...byId.values()];

  // Scalars: restrictive direction only.
  out.session.goal_required = user.session.goal_required || repo.session.goal_required;
  out.checkpoint.auto = user.checkpoint.auto || repo.checkpoint.auto;
  out.context.warn_pct = Math.min(user.context.warn_pct, repo.context.warn_pct);
  out.judge.enabled = user.judge.enabled;
  if (repo.judge.enabled === false && user.judge.enabled === true) {
    notices.push({
      code: 'POLICY_WIDENING_REFUSED',
      detail: 'repo usewarden.yaml tried to disable the drift judge. Ignored.',
    });
  }
  // Telemetry is the user's decision alone; a repo can never turn it on.
  out.telemetry.enabled = user.telemetry.enabled;
  if (repo.telemetry.enabled && !user.telemetry.enabled) {
    notices.push({
      code: 'POLICY_WIDENING_REFUSED',
      detail: 'repo usewarden.yaml tried to enable telemetry. Ignored - telemetry is opt-in by you only.',
    });
  }

  return out;
}

function unionStrings(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])];
}

/** Walk up looking for a `.git` dir. Returns null when not in a repo. */
export function findRepoRoot(from: string): string | null {
  let dir = path.resolve(from);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Renders the starter policy that `usewarden init` writes. Kept as text so comments survive. */
export function starterPolicyYaml(repoRoot: string): string {
  const p = defaultPolicy(repoRoot);
  const lines: string[] = [];
  lines.push('# usewarden policy');
  lines.push('# Docs: https://github.com/djayamah/usewarden#policy');
  lines.push('#');
  lines.push('# This file is DATA. Usewarden never executes anything from it. Unknown keys are a');
  lines.push('# hard error rather than a silent no-op, so a typo cannot quietly disable a rule.');
  lines.push('version: 1');
  lines.push('');
  lines.push('scope:');
  lines.push('  # Paths the agent is allowed to touch. Anything else is out of scope.');
  lines.push('  allowed_paths:');
  for (const a of p.scope.allowed_paths) lines.push(`    - ${quote(a)}`);
  lines.push('  # Never, regardless of allowed_paths.');
  lines.push('  forbidden_paths:');
  for (const f of p.scope.forbidden_paths) lines.push(`    - ${quote(f)}`);
  lines.push('');
  lines.push('protected_branches:');
  for (const b of p.protected_branches) lines.push(`  - ${quote(b)}`);
  lines.push('');
  lines.push('commands:');
  lines.push('  # Regex matched case-insensitively against the command line.');
  lines.push('  deny:');
  for (const r of p.commands.deny) {
    lines.push(`    - id: ${quote(r.id)}`);
    lines.push(`      pattern: ${quote(r.pattern)}`);
    lines.push(`      reason: ${quote(r.reason)}`);
    lines.push(`      action: ${r.action}`);
    if (r.outsideRepoOnly) lines.push('      outsideRepoOnly: true');
  }
  lines.push('');
  lines.push('# Free-text rules the Layer-2 judge checks semantically. Add your own.');
  lines.push('invariants: []');
  lines.push('');
  lines.push('session:');
  lines.push('  goal_required: false');
  lines.push('');
  lines.push('context:');
  lines.push('  warn_pct: 60');
  lines.push('');
  lines.push('checkpoint:');
  lines.push('  auto: true');
  lines.push('');
  lines.push('judge:');
  lines.push('  enabled: true');
  lines.push('  every_n_events: 15');
  lines.push('  max_calls_per_session: 8');
  lines.push('  model: null');
  lines.push('');
  lines.push('telemetry:');
  lines.push('  enabled: false');
  lines.push('');
  return lines.join('\n');
}

function quote(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
