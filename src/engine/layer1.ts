import * as path from 'node:path';
import * as fs from 'node:fs';
import type { NormalizedEvent, Verdict } from '../types.js';
import type { Policy } from '../policy/schema.js';
import { ALLOW } from '../types.js';
import { isInside, matchesAnyGlob, resolveUserPath, ellipsis, oneLine } from '../util.js';
import { findRepoRoot } from '../policy/load.js';

/**
 * LAYER 1 - deterministic, zero tokens, runs on every single event.
 *
 * Ordering is non-negotiable (spec section 3.4): this runs BEFORE any LLM is consulted, and it
 * never disables, not even when the judge is down. It must alone catch >=80% of the sabotage
 * suite; `tests/sabotage/coverage.test.ts` asserts that number rather than trusting the claim.
 *
 * Every check here is pure over (event, policy, filesystem facts). No subprocess is ever spawned
 * from event data - see THREAT-MODEL T-05.
 */

export interface Layer1Context {
  policy: Policy;
  /** Current git branch of the event's cwd, if determinable. */
  branch?: string;
  /** Sibling directories of the repo root, used for the sibling-repo check. */
  repoRoot?: string;
}

export function evaluateLayer1(e: NormalizedEvent, ctx: Layer1Context): Verdict {
  const p = ctx.policy;

  if (e.event === 'pre_tool') {
    const target = e.filePath;
    const base = ctx.repoRoot ?? e.cwd ?? process.cwd();

    // --- 1. forbidden paths (absolute veto, checked before allowed_paths) --------------
    if (target) {
      const abs = resolveUserPath(target, base);
      const fi = p.scope.forbidden_paths.findIndex((g) => matchesAnyGlob(abs, [g], base));
      if (fi >= 0) {
        return {
          decision: 'deny',
          reason: `Usewarden: ${path.basename(abs)} is on the forbidden list (${p.scope.forbidden_paths[fi]}). Usewarden blocks all agent access to credentials and key material. Do not retry; ask the human if you genuinely need this value.`,
          rule: `scope.forbidden_paths[${fi}]`,
          layer: 1,
          severity: 'block',
        };
      }

      // --- 2. out-of-scope writes -----------------------------------------------------
      const mutating = e.tool === 'write' || e.tool === 'edit';
      if (mutating && p.scope.allowed_paths.length > 0) {
        const inScope = p.scope.allowed_paths.some((a) => isInside(resolveUserPath(a, base), abs)
          || matchesAnyGlob(abs, [a], base));
        if (!inScope) {
          const sibling = siblingRepoOf(ctx.repoRoot, abs);
          const extra = sibling
            ? ` That path is inside a DIFFERENT repository (${path.basename(sibling)}) sitting beside this one.`
            : '';
          return {
            decision: 'deny',
            reason: `Usewarden: ${abs} is outside this session's allowed scope.${extra} Allowed: ${p.scope.allowed_paths.join(', ')}. Work inside the repo, or have the human widen scope in usewarden.yaml.`,
            rule: 'scope.allowed_paths',
            layer: 1,
            severity: 'block',
          };
        }
      }
    }

    // --- 3. command deny list -----------------------------------------------------------
    if (e.tool === 'bash' && e.command) {
      const cmd = e.command;
      for (let i = 0; i < p.commands.deny.length; i++) {
        const rule = p.commands.deny[i]!;
        let re: RegExp;
        try { re = new RegExp(rule.pattern, 'i'); } catch { continue; }
        if (!re.test(cmd)) continue;

        if (rule.outsideRepoOnly && commandTargetsOnlyAllowedPaths(cmd, p, base)) continue;

        // Protected-branch refinement: a force-push only matters to a protected branch.
        if (rule.id === 'force-push-protected' && !targetsProtectedBranch(cmd, p, ctx.branch)) {
          continue;
        }

        return {
          decision: rule.action === 'block' ? 'deny' : 'allow',
          reason: `Usewarden: ${rule.reason}`,
          rule: `commands.deny[${i}] (${rule.id})`,
          layer: 1,
          severity: rule.action === 'block' ? 'block' : 'warn',
        };
      }
    }

    // --- 4. .env reads via file tools (not only via bash) --------------------------------
    if ((e.tool === 'read' || e.tool === 'grep') && e.filePath && /(^|\/)\.env(\.|$)/.test(e.filePath)) {
      return {
        decision: 'deny',
        reason: 'Usewarden: reading a .env file puts live credentials into the model context. Blocked. Ask the human for the specific value you need.',
        rule: 'scope.forbidden_paths (.env)',
        layer: 1,
        severity: 'block',
      };
    }
  }

  // --- 5. context fill ------------------------------------------------------------------
  if (typeof e.contextFill === 'number' && e.contextFill * 100 >= p.context.warn_pct) {
    return {
      decision: 'allow',
      reason: `Usewarden: context is ${Math.round(e.contextFill * 100)}% full (threshold ${p.context.warn_pct}%). Compact now.`,
      rule: 'context.warn_pct',
      layer: 1,
      severity: 'warn',
      advice: 'compact-advice',
    };
  }

  return ALLOW;
}

/**
 * True when every filesystem-looking argument in the command resolves inside allowed_paths.
 * Conservative by design: an argument usewarden cannot classify counts as OUTSIDE, so an
 * `rm -rf $SOMETHING` is treated as dangerous rather than waved through.
 */
export function commandTargetsOnlyAllowedPaths(cmd: string, p: Policy, base: string): boolean {
  const args = tokenize(cmd).filter((t) => !t.startsWith('-'));
  const candidates = args.slice(1).filter((a) => a !== '');
  if (candidates.length === 0) return false;
  for (const a of candidates) {
    if (/[$`*?]/.test(a)) return false;         // unresolvable or glob: assume dangerous
    if (a === '/' || a === '~' || a === '~/') return false;
    const abs = resolveUserPath(a, base);
    const inScope = p.scope.allowed_paths.some((al) => isInside(resolveUserPath(al, base), abs));
    if (!inScope) return false;
  }
  return true;
}

/** Split a command into tokens, honouring quotes. Never executes anything. */
export function tokenize(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (q) {
      if (c === q) q = null; else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { q = c; continue; }
    if (/\s/.test(c)) { if (cur !== '') { out.push(cur); cur = ''; } continue; }
    cur += c;
  }
  if (cur !== '') out.push(cur);
  return out;
}

/**
 * A `git push --force` matters when the refspec names a protected branch, or when no refspec is
 * given and the CURRENT branch is protected. Unknown branch => treat as protected (fail safe).
 */
export function targetsProtectedBranch(cmd: string, p: Policy, currentBranch?: string): boolean {
  const toks = tokenize(cmd).filter((t) => !t.startsWith('-'));
  // git push [remote] [refspec...]
  const pushIdx = toks.findIndex((t) => t === 'push');
  const refs = pushIdx >= 0 ? toks.slice(pushIdx + 2) : [];
  if (refs.length > 0) {
    return refs.some((r) => {
      const dst = r.includes(':') ? r.slice(r.indexOf(':') + 1) : r;
      const name = dst.replace(/^refs\/heads\//, '').replace(/^\+/, '');
      return p.protected_branches.includes(name);
    });
  }
  if (!currentBranch) return true;
  return p.protected_branches.includes(currentBranch);
}

/**
 * Detects "the agent is writing into the repo NEXT DOOR" - the single most damaging real-world
 * drift on a machine with many checkouts side by side.
 */
export function siblingRepoOf(repoRoot: string | undefined, abs: string): string | null {
  if (!repoRoot) return null;
  const parent = path.dirname(path.resolve(repoRoot));
  if (!isInside(parent, abs)) return null;
  const rel = path.relative(parent, abs);
  const first = rel.split(path.sep)[0];
  if (!first || first === path.basename(repoRoot)) return null;
  const candidate = path.join(parent, first);
  try {
    if (fs.existsSync(path.join(candidate, '.git'))) return candidate;
  } catch { /* unreadable is not a sibling repo */ }
  return null;
}

/** Renders the human-facing one-liner for an incident card. */
export function describeAttempt(e: NormalizedEvent): string {
  if (e.tool === 'bash' && e.command) return `$ ${ellipsis(oneLine(e.command), 200)}`;
  if (e.filePath) return `${e.rawTool ?? e.tool ?? 'tool'} ${e.filePath}`;
  if (e.event === 'user_prompt' && e.prompt) return `prompt: ${ellipsis(oneLine(e.prompt), 160)}`;
  return `${e.rawTool ?? e.tool ?? e.event}`;
}

/** Current git branch for a directory, or undefined. Reads .git, never shells out. */
export function currentBranch(cwd: string): string | undefined {
  const root = findRepoRoot(cwd);
  if (!root) return undefined;
  try {
    const gitPath = path.join(root, '.git');
    const st = fs.statSync(gitPath);
    const gitDir = st.isDirectory() ? gitPath : path.resolve(root, fs.readFileSync(gitPath, 'utf8').replace(/^gitdir:\s*/, '').trim());
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}
