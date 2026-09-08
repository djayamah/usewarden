import * as path from 'node:path';
import * as fs from 'node:fs';
import type { NormalizedEvent, Verdict } from '../types.js';
import type { Policy } from '../policy/schema.js';
import { ALLOW } from '../types.js';
import { isInside, isEphemeralPath, matchesAnyGlob, resolveUserPath, ellipsis, oneLine } from '../util.js';
import { findRepoRoot } from '../policy/load.js';
import { lex, unquote, verbOf, type Lex, type HeredocSpan, type Word } from './shlex.js';
import { gitFileState, isUnrecoverable } from './gitstate.js';
import { findException, remaining, type Exception } from '../exceptions.js';

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
  /**
   * Live, unexpired `usewarden allow` exceptions. Loaded by the caller so this stays pure.
   *
   * They are applied at ONE choke point below rather than at each deny site, so a rule added later
   * cannot forget to honour them - and, more importantly, cannot forget to RECORD that it did.
   */
  exceptions?: readonly Exception[];
  /**
   * True when THIS session already wrote to the event's target.
   *
   * The uncommitted-work guard is meaningless without it. An agent's first write makes a file
   * dirty, so a guard that only asked "is this file dirty" would refuse the agent's own second
   * write to its own file - blocking normal work within one turn of being installed. The question
   * that matters is not "is there uncommitted work here" but "is there uncommitted work here that
   * SOMEONE ELSE did". The caller answers it from the session's own event history.
   */
  agentAuthored?: boolean;
  /**
   * `live` (default) lets the checks below consult the filesystem. `fenced` forbids it.
   *
   * REPLAY IS THE REASON THIS EXISTS, AND IT IS A SAFETY FENCE BEFORE IT IS A CORRECTNESS ONE.
   *
   * Two checks here read the disk: `gitFileState` (protect_uncommitted) and `siblingRepoOf`
   * (message enrichment on an out-of-scope write). A replay re-evaluates STORED actions, and the
   * paths in a stored action are whatever the agent typed months ago - on this machine, that
   * corpus contains paths CLAUDE.md §1 forbids this repository's tooling from touching at all.
   * A replay that stat()ed its own corpus would walk straight into them, and would do it
   * silently, because `fs.existsSync` on a forbidden path returns a boolean rather than an error.
   *
   * It is also the correct answer on the merits. Replaying a write from August against today's
   * git index measures today's checkout, not the incident.
   *
   * The two checks are fenced DIFFERENTLY, and the difference is the honest part:
   *   - `siblingRepoOf` only decorates a message, so skipping it cannot change a verdict. Skipped
   *     silently.
   *   - `gitFileState` DECIDES a verdict, so skipping it would turn a block into an allow and
   *     quietly flatter every precision figure computed downstream. It is reported through
   *     `onUnevaluable` instead, and the replay marks that row INDETERMINATE rather than
   *     counting it as either a pass or a fail. CLAUDE.md §4.4.
   */
  filesystem?: 'live' | 'fenced';
  /** Called when a check could not be evaluated. See `filesystem`. */
  onUnevaluable?: (rule: string, why: string) => void;
  /**
   * The two filesystem probes Layer 1 makes, injectable.
   *
   * They are parameters rather than direct imports for ONE reason: it is the only way to write a
   * test that PROVES the fence holds. `fs` reached through an ESM import is a frozen namespace
   * object, so a test cannot spy on it; a test that instead asserted "the verdict looks right"
   * would pass just as happily if the fence had been deleted. With the probes injected,
   * `tests/replay.test.ts` R4 hands in stubs that throw, and the fenced path is proved by the
   * call not throwing - while the same stubs in `live` mode DO throw, which is what keeps that
   * assertion from being vacuous.
   */
  probes?: Layer1Probes;
}

export interface Layer1Probes {
  gitFileState: typeof gitFileState;
  siblingRepoOf: typeof siblingRepoOf;
}

export function evaluateLayer1(e: NormalizedEvent, ctx: Layer1Context): Verdict {
  const verdict = evaluateLayer1Raw(e, ctx);

  // --- the one place a human waiver is applied, and the one place it is recorded ----------------
  //
  // A single choke point rather than a check at each deny site: a rule added next month cannot
  // forget to honour an exception, and - the part that actually matters - cannot forget to say
  // that it did. A waived block is DOWNGRADED to a warning, never silenced. The incident row is
  // still written, it still appears on the receipt, and the reason names the exception and when it
  // expires. "Allowed because you said so" and "allowed because nothing objected" must never
  // render alike, or the audit trail is worth nothing.
  if (verdict.decision !== 'deny' || !verdict.rule) return verdict;
  const ex = findException(verdict.rule, ctx.repoRoot, ctx.exceptions ?? []);
  if (!ex) return verdict;

  return {
    ...verdict,
    decision: 'allow',
    severity: 'warn',
    reason: `Usewarden: WAIVED by \`usewarden allow ${ex.rule}\` (${remaining(ex)}). `
      + `This would have been blocked: ${verdict.reason.replace(/^Usewarden:\s*/, '')}`,
  };
}

/** The policy evaluation itself, before any human waiver is considered. */
function evaluateLayer1Raw(e: NormalizedEvent, ctx: Layer1Context): Verdict {
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
        // The agent's own scratchpad is in scope when `allow_ephemeral` is on.
        //
        // THE SECOND HALF OF THIS CONDITION IS NOT BELT AND BRACES, IT IS THE FENCE. The
        // forbidden-path veto above resolves each glob against the REPOSITORY, so `**/.env`
        // becomes `<repo>/**/.env` and protects nothing outside the repository. Under
        // `allowed_paths` that never mattered - everything outside was refused anyway. Exempting
        // the scratchpad removed that backstop, and a `.env` written into a scratchpad would have
        // slipped through a rule whose whole point is that it is absolute. Caught by test E3,
        // which was written to assert the claim the comment here was making, and initially failed.
        //
        // Re-testing the forbidden globs anchored at `/` is what makes `**/.env` mean what it
        // plainly says: any .env, anywhere.
        const ephemeral = p.scope.allow_ephemeral
          && isEphemeralPath(abs)
          && !matchesAnyGlob(abs, p.scope.forbidden_paths, '/');
        const inScope = ephemeral
          || p.scope.allowed_paths.some((a) => isInside(resolveUserPath(a, base), abs)
          || matchesAnyGlob(abs, [a], base));
        if (!inScope) {
          // Message enrichment only - see Layer1Context.filesystem. Skipping it under the fence
          // cannot change the verdict, only the sentence.
          const sibling = ctx.filesystem === 'fenced'
            ? null
            : (ctx.probes?.siblingRepoOf ?? siblingRepoOf)(ctx.repoRoot, abs);
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

      // --- 2b. work git cannot get back ------------------------------------------------
      //
      // Scope allows every write inside the repository, which is what makes usewarden usable and
      // is also the hole anthropics/claude-code#53900 went through: the agent destroyed a file
      // that was inside the project and had never been committed. Measured against the real-
      // incident corpus this was the last remaining miss that was OURS to fix, and it was the
      // most valuable one, because it guards the most ordinary action an agent takes.
      //
      // It is scoped to whole-file replacement on purpose. `write` substitutes the entire
      // contents; `edit` is a surgical replacement that leaves the rest of the file standing, and
      // firing on it would put this guard in front of nearly every turn of nearly every session
      // for a fraction of the risk. Narrow and true beats broad and resented
      // (docs/FALSE-POSITIVES.md).
      //
      // It BLOCKS rather than warns, and the reason is specific to pre_tool: a warning on a
      // PreToolUse event allows the call. The file is gone and the incident card says we watched
      // it happen. `checkpoint.auto` does not cover this either - it tags HEAD, which is exactly
      // the work that was already safe.
      if (p.scope.protect_uncommitted && e.tool === 'write' && !ctx.agentAuthored && ctx.repoRoot) {
        if (ctx.filesystem === 'fenced') {
          // NOT an allow. The caller is told the check could not run, and is expected to report
          // the row as indeterminate. Falling through to ALLOW here would have been one line
          // shorter and would have made every replayed write look like a clean pass.
          ctx.onUnevaluable?.('scope.protect_uncommitted',
            'needs the git index and working tree as they were; the filesystem is fenced');
        } else {
          const state = (ctx.probes?.gitFileState ?? gitFileState)(abs, ctx.repoRoot);
          if (isUnrecoverable(state)) {
            // REPO-RELATIVE, NOT THE BASENAME. The first version suggested `git add todos.js` for a
            // file at `src/todos.js`, which fails from the repository root - a message telling the
            // agent to run a command that does not work. A live session caught it by ignoring the
            // command and running the right one; the next agent might not.
            const name = path.relative(ctx.repoRoot, abs) || path.basename(abs);
            const untracked = state === 'untracked';
            return {
              decision: 'deny',
              reason: untracked
                // "Commit or stash it first (`git add ...`)" was the first wording, and a live
                // session showed the seam: `git add` is neither a commit nor a stash. The agent
                // followed the parenthetical, which was the right action - so the message now says
                // what that action actually achieves instead of mislabelling it.
                ? `Usewarden: ${name} exists and git has never seen it, so the copy on disk is the only one. Replacing it wholesale would destroy work nobody can get back. Put the current contents somewhere recoverable first — \`git add ${name}\` is enough — or write to a different file.`
                : `Usewarden: ${name} has uncommitted changes that git cannot restore. Replacing the whole file would discard them. Stage or commit them first (\`git add ${name}\`), or make a targeted edit that keeps what is already there.`,
              rule: `scope.protect_uncommitted (${state})`,
              layer: 1,
              severity: 'block',
            };
          }
        }
      }
    }

    // --- 3. command deny list -----------------------------------------------------------
    //
    // Evaluated PER STATEMENT, not over the whole command line. A rule that matches anywhere in a
    // long chain fires on unrelated neighbours: a push to a feature branch chained with an
    // unrelated force flag on a DIFFERENT command was blocked as a force-push to a protected
    // branch, because all three tokens appeared somewhere in one line. Found in production,
    // blocking this repository's own maintainer for the second time.
    //
    // The split is on `&&`, `||`, `;` and newlines ONLY - deliberately NOT on `|`. A pipe is not a
    // statement boundary for our purposes: a download piped into a shell is a single dangerous
    // idea spanning a pipe, and splitting there would have quietly disabled that rule. Narrowing
    // one guard must never be allowed to widen a hole somewhere else.
    if (e.tool === 'bash' && e.command) {
      // Heredoc bodies being written as DATA are removed before pattern matching. See
      // stripDataHeredocs: the incident card still shows the original command, so nothing is
      // hidden from the reader - only the matcher stops reading file contents as commands.
      const cmd = stripDataHeredocs(e.command);
      for (let i = 0; i < p.commands.deny.length; i++) {
        const rule = p.commands.deny[i]!;
        let re: RegExp;
        try { re = new RegExp(rule.pattern, 'i'); } catch { continue; }

        // The statement that actually matched, so every refinement below judges the right text.
        const segment = statements(cmd).find((st) => re.test(st));
        if (segment === undefined) continue;

        if (rule.outsideRepoOnly && commandTargetsOnlyAllowedPaths(segment, p, base)) continue;

        // Protected-branch refinement, driven by the rule's own flag rather than by its id.
        // It was `rule.id === 'force-push-protected'`, which made the refinement unreachable to
        // any other rule and to any user-written one. See CommandRule.protectedBranchOnly.
        if (rule.protectedBranchOnly && !targetsProtectedBranch(segment, p, ctx.branch)) continue;

        return {
          decision: rule.action === 'block' ? 'deny' : 'allow',
          reason: `Usewarden: ${rule.reason}`,
          rule: `commands.deny[${i}] (${rule.id})`,
          layer: 1,
          severity: rule.action === 'block' ? 'block' : 'warn',
        };
      }
    }

    // --- 3b. .env in a bash command, structurally ----------------------------------------
    //
    // FOUND BY A LIVE SESSION, NOT BY A TEST (verification/live/11-metrics-retry.txt).
    //
    // The `dotenv-access` deny rule enumerates readers - cat, less, head, tail, cp, source and
    // so on. A real Claude Code session reached the same data with
    // `sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' .env` and was not blocked, because `sed`
    // is not on that list. Neither are awk, grep, cut, tr, jq, python, perl, dd, base64, nl,
    // sort, uniq, split, tee, or the next one somebody thinks of. A denylist of readers is a
    // list that is wrong the moment it is written.
    //
    // So this check inverts the polarity for one narrow, high-value case: a command segment that
    // names a real `.env` file is BLOCKED unless its leading command is on a short allowlist of
    // operations that cannot disclose the contents. Unknown command touching a credential file
    // means blocked, not "probably fine".
    //
    // Scoped tightly to keep it from becoming the over-guard the spec warns about (3A.6):
    // it applies only to `.env`-family files, only to bash, and only to the segment that
    // actually names one. `.env.example` and its siblings are conventionally non-secret and are
    // exempt. The regex rule above is left in place: it names the reader in its message, which
    // is a better sentence when it fires, and users can see and edit it.
    if (e.tool === 'bash' && e.command) {
      const seg = dotenvSegment(e.command);
      if (seg) {
        return {
          decision: 'deny',
          reason: `Usewarden: \`${seg.command}\` reads or copies ${seg.file}, which would put live credentials into the model context. `
            + 'Usewarden blocks every .env access it cannot prove is harmless. Ask the human for the specific value, or use .env.example.',
          rule: 'scope.forbidden_paths (.env via bash)',
          layer: 1,
          severity: 'block',
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
  // `warn_pct` is null unless the user opted in, and `contextFill` is populated by no adapter, so
  // in practice this branch is unreachable in production today. It is kept, tested and honest
  // rather than deleted: the logic is correct and the day an agent starts reporting the figure it
  // becomes live again with one policy line. What changed is that usewarden no longer ADVERTISES
  // it as active protection. See D-225 and src/policy/inputs.ts.
  if (p.context.warn_pct !== null
      && typeof e.contextFill === 'number' && e.contextFill * 100 >= p.context.warn_pct) {
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

  // A SHELL OR AN INTERPRETER TAKES PROGRAMS, NOT PATHS — and reading one as the other was a
  // hole, not an annoyance. FOUND 2026-09-08 by a sabotage test written for a different fix, and
  // confirmed against the shipped engine before changing anything:
  //
  //     sh -c 'rm -rf /'        -> ALLOW
  //     bash -c 'rm -rf /etc'   -> ALLOW
  //
  // `tokenize` strips the quotes, so the whole program became a single token `rm -rf /`, which
  // `resolveUserPath` then resolved RELATIVE TO THE REPOSITORY into `<repo>/rm -rf /` — a path
  // inside the allowed scope. Every candidate looked in-scope, so `outsideRepoOnly` skipped the
  // recursive-delete rule entirely. The guard's own doctrine is that an argument it cannot
  // classify counts as OUTSIDE; the defect was that it classified this one, confidently and
  // wrongly.
  //
  // The check is at the front rather than inside the loop because it is about the VERB, not about
  // any one argument: nothing this function can learn from the arguments of `sh -c` is a path.
  // A RUNNER PREFIX IS NOT THE PROGRAM. `sh -c` was fixed above; `env sh -c`, `nice sh -c`,
  // `timeout 5 sh -c`, `nohup sh -c`, `find . -exec sh -c` and eighteen more shapes were not, and
  // every one of them was still ALLOW after that fix. MEASURED 2026-09-08 against the bytes
  // published to npm as 0.1.1 and against the committed HEAD, both, in
  // `verification/escape-class-2026-09-08/`: 41 of 48 wrapped forms allowed on 0.1.1, 24 of 48
  // still allowed on the "fixed" engine.
  //
  // The four that 0.1.1 happened to refuse — `flock`, `script`, `chroot`, `make` — refused for a
  // reason that had nothing to do with the escape: one of the RUNNER's own arguments (`/tmp/l`,
  // `/dev/null`, `/`) resolved outside the repository. Change it to an in-repo path and all four
  // allow, which is what `matrix2-result.txt` records. So the previous coverage was not partial;
  // it was accidental, and a defence that works by accident is a defence that stops working when
  // somebody types a different filename.
  //
  // The effective verb is therefore resolved by walking PAST any runner prefix before the shell
  // test is applied.
  const verb = effectiveVerb(args);
  if (SHELL_VERBS.has(verb) || FOREIGN_INTERPRETERS.has(verb)) return false;
  for (const a of candidates) {
    // A TOKEN WITH A SPACE IN IT IS A PROGRAM STRING, NOT A PATH THIS FUNCTION SHOULD TRUST.
    //
    // The second, independent fence, and the one that does not depend on knowing every runner's
    // name. `tokenize` strips quotes, so `-c 'rm -rf /'` arrives here as the single token
    // `rm -rf /`, which `resolveUserPath` cheerfully turns into `<repo>/rm -rf /` — a path inside
    // the allowed scope. That resolution is the mechanism of EVERY escape in the matrix, whatever
    // the verb, including the ones nobody has thought of yet.
    //
    // The cost is a path that genuinely contains a space, which stops being waved through and is
    // evaluated against the deny rules instead. Measured on the frozen 92-block label set: zero
    // change to precision or coverage.
    if (/\s/.test(a)) return false;
    if (/[$`*?]/.test(a)) return false;         // unresolvable or glob: assume dangerous
    if (a === '/' || a === '~' || a === '~/') return false;
    const abs = resolveUserPath(a, base);
    // Checked AFTER the unresolvable test above, deliberately: `rm -rf "$T"` stays dangerous even
    // though $T usually holds a temp path, because usually is not always. The forbidden-glob
    // re-test is the same fence as in the scope branch - see the note there.
    if (p.scope.allow_ephemeral && isEphemeralPath(abs)
        && !matchesAnyGlob(abs, p.scope.forbidden_paths, '/')) continue;
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


/**
 * Commands that may name a `.env` file without being able to disclose its contents.
 *
 * Deliberately short. Anything not here is treated as a reader, because the cost of wrongly
 * blocking `stat .env` is a confused user with a clear message, and the cost of wrongly allowing
 * `perl -ne 'print' .env` is a credential in a model context, permanently.
 */
const DOTENV_SAFE_COMMANDS = new Set([
  'ls', 'stat', 'test', '[', '[[', 'find', 'touch', 'file', 'basename', 'dirname',
  'echo', 'printf', 'wc', 'du', 'realpath', 'readlink', 'chmod', 'chown', 'ln',
]);

/** `.env.example` and friends are conventions for a file with no secrets in it. */
const DOTENV_EXEMPT = /^\.env\.(example|sample|template|dist|defaults?)$/i;

/**
 * Finds the first command segment that names a real `.env` file with a command that is not on
 * the safe list. Returns the offending command and file, or null.
 *
 * Segments are split on the shell operators that start a new command, so
 * `ls -la .env && sed -n '...' .env` is judged per segment: `ls` is fine, `sed` is not.
 */
export function dotenvSegment(cmd: string): { command: string; file: string } | null {
  for (const raw of cmd.split(/\s*(?:&&|\|\||[;|\n])\s*/)) {
    const seg = raw.trim();
    if (seg === '') continue;
    const tokens = tokenize(seg);
    if (tokens.length === 0) continue;

    // Skip leading VAR=value assignments and `sudo`/`env` style prefixes to find the real verb.
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++;
    while (i < tokens.length && (tokens[i] === 'sudo' || tokens[i] === 'command' || tokens[i] === 'env')) i++;
    const verb = (tokens[i] ?? '').split('/').pop() ?? '';
    // The verb must look like a COMMAND NAME. Found in production, blocking this very
    // repository's own maintainer mid-task: a YAML list item inside a heredoc -
    //     - "**/<dotenv glob>"
    // - was split into a segment whose first token is `-`, which was then treated as a command
    // reading a credential file. Writing a policy that LISTS the patterns it protects became
    // impossible while usewarden was running. A leading `-` is a flag or a bullet, punctuation is
    // not a program, and neither can read anything.
    if (!/^[A-Za-z_][A-Za-z0-9_.+-]*$/.test(verb)) continue;

    const file = tokens.slice(i + 1).find((t) => {
      if (t.startsWith('-')) return false;
      const b = t.split('/').pop() ?? '';
      return /^\.env(\.[A-Za-z0-9_-]+)?$/.test(b) && !DOTENV_EXEMPT.test(b);
    });
    if (!file) continue;
    if (DOTENV_SAFE_COMMANDS.has(verb)) continue;
    return { command: verb, file };
  }
  return null;
}


/**
 * Splits a command line into STATEMENTS: the units a deny-rule should be judged against.
 *
 * Splits on `&&`, `||`, `;` and newlines. Deliberately NOT on `|` - see the note at the deny-list
 * evaluation. Returns the whole string when there is only one statement.
 */
export function statements(cmd: string): string[] {
  const parts = cmd.split(/\s*(?:&&|\|\||;|\n)\s*/).map((x) => x.trim()).filter((x) => x !== '');
  return parts.length > 1 ? parts : [cmd];
}

/**
 * THERE IS NO LIST OF SAFE HEREDOC CONSUMERS, AND TRYING TO KEEP ONE FAILED FOUR TIMES.
 *
 * The first version of this gated on an allowlist of "data sinks" — `cat` and `tee`. That list was
 * wrong the moment it was written, and it was wrong in the direction that blocks legitimate work:
 *
 *   `cat > notes.md <<EOF`        on the list, fine
 *   `python3 - <<EOF`             correctly excluded, the body executes
 *   `git commit -F - <<EOF`       NOT on the list, so a commit MESSAGE describing a dangerous
 *                                 command was refused — the fourth time this guard blocked its
 *                                 own author writing prose in one day
 *
 * So the polarity is inverted, the way the .env check already inverts it. A heredoc body is DATA
 * unless something will EXECUTE it. That is an allowlist of dangerous rather than an allowlist of
 * safe, and the list of interpreters is short, stable and enumerable in a way the list of
 * file-writing commands is not.
 *
 * WHAT CHANGED ON 2026-09-08 (D-279), and why it is a correction rather than a loosening.
 *
 * The consumer used to be identified by testing a regex against the whole opener LINE. Two
 * defects followed, and between them they accounted for 14 of the 29 false positives left in the
 * labelled corpus:
 *
 *   1. `cat > scripts/restore-check.sh <<'SHEOF'` was read as naming a shell, because
 *      `\b(ba|z|k|da|fi)?sh\b` matches the `.sh` on a FILENAME. POSIX §2.9.1.1 says the command
 *      name is "the first field ... that is not a variable assignment or redirection". A suffix
 *      on a redirection target is not a command. The consumer is now the command-position word,
 *      from the lexer.
 *
 *   2. A body handed to `python3 - <<'PY'` was scanned in full whenever it contained a BACKTICK,
 *      because backticks are command substitution — in shell. They are not in Python, they are a
 *      syntax error; and in Markdown prose, which is what these bodies mostly were, they are a
 *      code span. Twelve blocks, every one of them an agent writing documentation.
 *
 *      POSIX §2.7.4 settles the general case and settles it more strongly than the special case
 *      needed: when the here-document delimiter is quoted — `<<'PY'`, which every one of those
 *      twelve used — "the here-document lines shall not be expanded". No parameter expansion, no
 *      command substitution, no arithmetic. A backtick inside `<<'PY'` is a literal backtick as a
 *      matter of the shell grammar, not as a matter of our judgement. With an UNQUOTED delimiter
 *      all three expansions do happen, so that case still fails closed.
 *
 * IT STILL FAILS CLOSED, four ways:
 *   - the lexer returns `ok: false` for anything it does not understand — an unbalanced quote, an
 *     unterminated heredoc, a command substitution it would have to recurse into — and this
 *     function then strips NOTHING and behaves exactly as it did before;
 *   - a body whose consumer is a shell is never stripped;
 *   - a body handed to a non-shell interpreter is stripped only when it contains no route back to
 *     a shell IN THAT LANGUAGE;
 *   - `cat <<EOF | bash` is still caught, because `bash` is at a command position after the pipe.
 *
 * Writing a file is still governed by SCOPE, which is unaffected: `cat > /etc/passwd <<EOF` is
 * refused for its target, not its contents.
 */

/** Anything that would execute heredoc text AS SHELL. */
/**
 * Commands whose own argument is ANOTHER PROGRAM rather than a file.
 *
 * `env`, `nice` and `timeout` do not open the things you hand them; they exec them. So the verb
 * that decides whether this command's arguments are paths is not the first word, it is the first
 * word that is not one of these. Deliberately generous — a name that merely looks like a runner
 * costs at worst a skipped optimisation, and a missing one costs a hole, which is the same
 * asymmetry FOREIGN_INTERPRETERS is written for.
 *
 * `sudo` and `su` are here for completeness of the walk; usewarden has its own rule about them.
 */
const RUNNER_VERBS = new Set([
  'env', 'nice', 'ionice', 'nohup', 'setsid', 'stdbuf', 'command', 'builtin', 'exec', 'time',
  'timeout', 'watch', 'script', 'flock', 'chroot', 'setarch', 'unbuffer', 'strace', 'ltrace',
  'dtruss', 'sudo', 'doas', 'su', 'parallel', 'find', 'ssh', 'npx', 'pnpm', 'yarn', 'bunx',
  'git', 'make', 'proot', 'firejail', 'systemd-run', 'runuser',
]);

/**
 * The verb whose arguments actually are paths, found by walking past every runner prefix.
 *
 * Tokens skipped along the way: `VAR=VALUE` assignments (`env FOO=1 sh -c …`), bare numbers and
 * durations (`timeout 5 …`, `nice 10 …`), and `find`'s `-exec` sentinels. Everything else ends the
 * walk. Bounded to eight hops so a pathological command cannot spin.
 */
export function effectiveVerb(args: readonly string[]): string {
  let i = 0;
  let hops = 0;
  const basename = (t: string): string => t.split('/').pop() ?? '';
  while (i < args.length && hops < 8) {
    const v = basename(args[i] ?? '');
    if (!RUNNER_VERBS.has(v)) return v;
    hops++;
    i++;
    while (i < args.length) {
      const t = args[i] ?? '';
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; }   // env assignment
      if (/^[0-9]+(\.[0-9]+)?[smhd]?$/.test(t)) { i++; continue; } // timeout/nice duration
      if (t === '{}' || t === ';' || t === '+' || t === '.') { i++; continue; } // find sentinels
      break;
    }
  }
  return basename(args[i] ?? '');
}

const SHELL_VERBS = new Set([
  'sh', 'bash', 'zsh', 'ksh', 'dash', 'fish', 'eval', 'source', '.', 'xargs', 'awk', 'sed',
]);

/**
 * Interpreters whose input is source in ANOTHER language. A body handed to one of these is not
 * shell, so matching shell deny patterns against it is a category error (D-256).
 */
const FOREIGN_INTERPRETERS = new Set([
  'python', 'python2', 'python3', 'node', 'nodejs', 'ruby', 'perl', 'php', 'deno', 'bun',
]);

/**
 * Ways OUT of each of those languages and back into a shell.
 *
 * PER LANGUAGE, and that is the fix rather than an elaboration of it. The single combined list
 * treated a backtick as an escape everywhere, which is true in Ruby, Perl and PHP and false in
 * Python and JavaScript — and false is the common case, because these bodies are usually source
 * code or Markdown. Each list stays deliberately generous: a name that merely LOOKS like one of
 * these costs a false positive, and a missing one costs a hole.
 */
const SHELL_ESCAPES_BY_LANGUAGE: Record<string, RegExp> = {
  python: /\bos\.system\b|\bsubprocess\b|\bos\.popen\b|\bcommands\.getoutput\b|\bpty\.spawn\b|\bos\.exec\w*\b|\bos\.spawn\w*\b/i,
  node: /\bchild_process\b|\bexecSync\b|\bspawnSync\b|\bexecFile\w*\b|\bspawn\s*\(|\bexec\s*\(|\bnode:child_process\b/i,
  ruby: /`[^`]*`|%x[({[|!]|\bsystem\s*\(|\bexec\s*\(|\bIO\.popen\b|\bKernel\.\w+|\bOpen3\b/i,
  perl: /`[^`]*`|\bqx[({/|!]|\bsystem\s*\(|\bexec\s*\(|\bopen\s*\([^)]*\|/i,
  php: /\bshell_exec\b|\bpassthru\b|\bproc_open\b|\bsystem\s*\(|\bexec\s*\(|`[^`]*`|\bpopen\s*\(/i,
};

function languageOf(verb: string): string | null {
  if (verb.startsWith('python')) return 'python';
  if (verb === 'node' || verb === 'nodejs' || verb === 'deno' || verb === 'bun') return 'node';
  if (verb === 'ruby') return 'ruby';
  if (verb === 'perl') return 'perl';
  if (verb === 'php') return 'php';
  return null;
}

/**
 * Can this body be treated as data even though a foreign interpreter will read it?
 *
 * Exported and separately tested because it is the one place where "this is source, not shell"
 * is decided, and getting it wrong in the permissive direction is the failure D-139 named.
 */
export function bodyIsForeignSource(verb: string, body: string): boolean {
  // FAIL CLOSED ON A MISUSE, not just on a dangerous body.
  //
  // This used to take the whole opener LINE and do its own shell detection. It now takes a bare
  // verb, because the shell-versus-foreign decision needs the lexer's command positions and no
  // regex over a line can supply them. A caller that passes the old argument — `"python3 -c 'x'
  // <<'PY' | sh"` — would otherwise match `startsWith('python')` and be told the body is inert,
  // which is the exact pipe-to-shell hole the sabotage suite exists to guard. A verb has no
  // whitespace and no metacharacters; anything else is a misuse and gets `false`.
  if (!/^[A-Za-z_][A-Za-z0-9_.+-]*$/.test(verb)) return false;
  const lang = languageOf(verb);
  if (!lang) return false;
  const escapes = SHELL_ESCAPES_BY_LANGUAGE[lang];
  return escapes !== undefined && !escapes.test(body);
}

/**
 * Commands that CANNOT execute an argument, so a dangerous string quoted as one of their
 * arguments is text they are carrying rather than a command about to run.
 *
 * `grep -n 'npm publish' CLAUDE.md` searches FOR the phrase. Eight blocks in the labelled corpus
 * were exactly this shape, several of them while the agent was reading this project's own policy.
 *
 * ALLOWLIST, not a denylist, and short on purpose. `sed` and `awk` are absent although they look
 * like they belong: both execute a program of their own, and GNU sed's `e` command runs a shell.
 * `xargs` is absent for the obvious reason. Anything not named here keeps today's behaviour.
 */
const INERT_VERBS = new Set([
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'ripgrep',
  'echo', 'printf', 'comm', 'diff', 'sort', 'uniq', 'wc', 'cut', 'tr',
  'basename', 'dirname', 'column', 'fold', 'nl', 'rev', 'paste', 'join', 'jq',
]);

/** `git commit -m "..."` carries a message. These subcommands take prose and run none of it. */
const GIT_MESSAGE_SUBCOMMANDS = new Set(['commit', 'tag', 'merge', 'notes', 'stash', 'revert']);

/** Flags whose VALUE is a program in the interpreter's own language, not shell. */
const EVAL_FLAGS = new Set(['-e', '-c', '-r', '--eval', '--execute', '-p', '-E']);

/**
 * Blanks out every span of a command that the shell will NOT execute, preserving offsets.
 *
 * This is the single concept the three 2026-09-08 class fixes share: a deny rule should be matched
 * against *the text the shell will run*, and everything else in the command line is data the
 * command is carrying. Replaced with spaces rather than deleted so that offsets, line structure
 * and `statements()` splitting are all unchanged — the incident card still shows the original
 * command, so nothing is hidden from the reader; only the matcher stops reading data as code.
 *
 * Returns the input unchanged whenever the lexer did not understand it.
 */
export function executableText(cmd: string): string {
  const l = lex(cmd);
  if (!l.ok) return cmd;

  const blanks: { start: number; end: number }[] = [];

  // --- 1. here-document bodies that nothing will execute -----------------------------------
  for (const h of l.heredocs) {
    const consumer = shellConsumerOf(l, h);
    if (consumer === 'shell') continue;                       // executed as shell: scan it all
    if (consumer === 'foreign') {
      const body = cmd.slice(h.bodyStart, h.bodyEnd);
      const verb = foreignVerbOf(l, h);
      // An UNQUOTED delimiter means the shell expands the body before the interpreter sees it
      // (POSIX §2.7.4), so a `$(...)` in there really does run. Fail closed on that case.
      if (!h.delimiterQuoted && /\$\(|`/.test(body)) continue;
      if (!verb || !bodyIsForeignSource(verb, body)) continue;
    }
    blanks.push({ start: h.bodyStart, end: h.bodyEnd });
  }

  // --- 2. quoted arguments to commands that cannot execute them -----------------------------
  // --- 3. `-e` / `-c` programs in a foreign language ----------------------------------------
  const words = l.words;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (!w.commandPosition) continue;
    const verb = verbOf(w);

    // The rest of this statement, up to the next command position.
    let end = words.length;
    for (let j = i + 1; j < words.length; j++) if (words[j]!.commandPosition) { end = j; break; }
    const args = words.slice(i + 1, end);

    if (isInertVerb(verb, args)) {
      for (const a of args) {
        // `hasExpansion` is the interlock: `grep "$(rm -rf /)" f` has an inert verb and a quoted
        // argument, and that argument runs a command before grep is invoked.
        if (a.hasExpansion) continue;
        if (a.quoting === 'single' || a.quoting === 'double') {
          blanks.push({ start: a.start, end: a.end });
        }
      }
      continue;
    }

    const lang = languageOf(verb);
    if (lang) {
      for (let k = 0; k < args.length; k++) {
        if (!EVAL_FLAGS.has(unquote(args[k]!.raw))) continue;
        const prog = args[k + 1];
        if (!prog) continue;
        if (prog.quoting !== 'single' && prog.quoting !== 'double') continue;
        if (prog.hasExpansion) continue;   // same interlock as above
        if (!bodyIsForeignSource(verb, prog.raw)) continue;
        blanks.push({ start: prog.start, end: prog.end });
      }
    }
  }

  if (blanks.length === 0) return cmd;
  const out = [...cmd];
  for (const b of blanks) {
    for (let i = b.start; i < b.end && i < out.length; i++) {
      if (out[i] !== '\n') out[i] = ' ';
    }
  }
  return out.join('');
}

function isInertVerb(verb: string, args: readonly Word[]): boolean {
  if (INERT_VERBS.has(verb)) return true;
  if (verb === 'git') {
    const sub = args.find((a) => !unquote(a.raw).startsWith('-'));
    return sub !== undefined && GIT_MESSAGE_SUBCOMMANDS.has(unquote(sub.raw));
  }
  return false;
}

/**
 * What will consume a here-document body: a shell, a foreign interpreter, or neither.
 *
 * "Neither" means the body is inert data — a file being written, a commit message, a PR body.
 * The consumer is looked for among the COMMAND-POSITION words on the opener's line, which is what
 * makes `cat <<EOF | bash` still fail closed: `bash` is at a command position after the pipe.
 */
function shellConsumerOf(l: Lex, h: HeredocSpan): 'shell' | 'foreign' | 'data' {
  let sawForeign = false;
  for (const w of l.words) {
    if (w.end > h.bodyStart) break;
    if (!w.commandPosition) continue;
    // Only the statement chain that opened this heredoc matters; words before an earlier
    // heredoc's body belong to an earlier line and are skipped by the offset test above.
    const verb = verbOf(w);
    if (SHELL_VERBS.has(verb)) {
      // A shell ANYWHERE on the opener chain wins, because `cat <<EOF | bash` executes the body.
      if (w.start >= lineStartOf(l, h)) return 'shell';
    }
    if (FOREIGN_INTERPRETERS.has(verb) && w.start >= lineStartOf(l, h)) sawForeign = true;
  }
  return sawForeign ? 'foreign' : 'data';
}

function foreignVerbOf(l: Lex, h: HeredocSpan): string | null {
  for (const w of l.words) {
    if (w.end > h.bodyStart) break;
    if (!w.commandPosition || w.start < lineStartOf(l, h)) continue;
    const verb = verbOf(w);
    if (FOREIGN_INTERPRETERS.has(verb)) return verb;
  }
  return null;
}

/** Offset at which the heredoc's opener line begins. */
function lineStartOf(_l: Lex, h: HeredocSpan): number {
  return h.bodyStart - h.openerLine.length - 1;
}

/**
 * Kept as the public name the rest of the engine and the tests call. It now delegates to
 * `executableText`, which does strictly more: heredoc bodies AND quoted inert arguments AND
 * foreign `-e` programs.
 */
export function stripDataHeredocs(cmd: string): string {
  if (!cmd.includes('<<') && !/['"]/.test(cmd)) return cmd;
  return executableText(cmd);
}
