import * as path from 'node:path';
import * as fs from 'node:fs';
import type { NormalizedEvent, Verdict } from '../types.js';
import type { Policy } from '../policy/schema.js';
import { ALLOW } from '../types.js';
import { isInside, matchesAnyGlob, resolveUserPath, ellipsis, oneLine } from '../util.js';
import { findRepoRoot } from '../policy/load.js';
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
        const state = gitFileState(abs, ctx.repoRoot);
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
 * Next would have been `gh pr create --body-file -`, `mail`, `jq`, `sqlite3 <<EOF`, and whatever
 * anyone thinks of after that. This is precisely the shape D-081 named about the `.env` readers:
 * *"a denylist of readers is a list that is wrong the moment it is written"* — the same mistake
 * with the polarity flipped.
 *
 * So the polarity is inverted, the way the .env check already inverts it. A heredoc body is DATA
 * unless the line that opens it names something that would EXECUTE it. That is an allowlist of
 * dangerous rather than an allowlist of safe, and the list of interpreters is short, stable and
 * enumerable in a way the list of file-writing commands is not.
 *
 * RESIDUAL RISK, STATED RATHER THAN HIDDEN: a command that executes its heredoc without naming a
 * recognised interpreter — `docker run img <<EOF`, or `$SHELL <<EOF` — has its body treated as
 * data. That is a real gap and it is narrower than the one it replaces: scope still governs every
 * write, the pipe-to-shell case is still caught because the interpreter is on the same line, and
 * the alternative was a guard that refuses documentation about its own subject matter.
 */
/**
 * Anything that would EXECUTE heredoc text. If one of these appears anywhere in the command line
 * the body is treated as code, which covers `cat <<EOF | bash` — where the leading word is a data
 * sink but the body is executed anyway.
 */
const INTERPRETERS =
  /\b(ba|z|k|da|fi)?sh\b|\bpython3?\b|\bnode\b|\bruby\b|\bperl\b|\bphp\b|\bpsql\b|\bmysql\b|\bsqlite3?\b|\bawk\b|\bsed\b|\beval\b|\bxargs\b|\bsource\b/;

/**
 * Remove heredoc BODIES that are being written as data, so command patterns are matched against
 * what the shell will RUN rather than against text it will merely store.
 *
 * WHY THIS EXISTS — D-139, and it cost real work twice in one day.
 *
 * `statements()` splits on newlines, so every line of a heredoc body becomes a statement the deny
 * rules are matched against. That is correct for `bash <<EOF`, where those lines are executed. It
 * is wrong for `cat > notes.md <<EOF`, where they are file contents — and the consequence was that
 * usewarden blocked its own maintainer from writing a release runbook because the prose contained
 * the words `npm publish`, and later from writing a security TEST FIXTURE because it contained
 * `rm -rf ~/`. A guardrail that cannot tell a command from a sentence about a command will
 * eventually block a user writing documentation, and they will not file a bug, they will uninstall.
 *
 * This is the using-versus-naming distinction (D-091) that `botProseOnly` already applies to the
 * triage bot's quotations, applied to shell text.
 *
 * IT FAILS CLOSED, three ways over:
 *   - only `cat` and `tee` heredocs are treated as data; anything else is scanned in full;
 *   - if any interpreter appears anywhere in the command, nothing is stripped;
 *   - if the closing delimiter is never found, nothing is stripped, because an unterminated
 *     heredoc means this function did not understand the command.
 *
 * Writing a file is still governed by SCOPE, which is unaffected: `cat > /etc/passwd <<EOF` is
 * refused for its target, not its contents. This only stops the CONTENTS being read as commands.
 */
export function stripDataHeredocs(cmd: string): string {
  if (!cmd.includes('<<')) return cmd;

  const lines = cmd.split('\n');
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    out.push(line);

    // THE HEREDOC MAY OPEN ON ANY LINE, NOT THE FIRST.
    //
    // The first version of this only examined line 0, so a script whose first line was `cd …`
    // and whose third line was `cat > notes.md <<EOF` got no stripping at all. Found the third
    // time this guard blocked its own author writing documentation — which is the same defect
    // this function exists to fix, one level up.
    const open = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (!open) continue;

    // PER LINE, and that is deliberate rather than lazy. The hazard being guarded is
    // `cat <<EOF | bash`, where the interpreter sits on the same line as the redirect — so a
    // per-line check closes it. Checking the whole command instead would mean one `node` anywhere
    // in a long script disabled stripping everywhere in it, which is how a narrow guard becomes a
    // broad one nobody can reason about.
    if (INTERPRETERS.test(line)) continue;

    const delim = open[2]!;
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if ((lines[j] ?? '').trim() === delim) { end = j; break; }
    }
    // Unterminated: do not guess. Leave the rest of the command to be scanned in full.
    if (end === -1) continue;

    // Skip the body. The delimiter line itself is dropped with it: it is shell punctuation, and
    // a lone `EOF` matches nothing anyway.
    i = end;
  }

  return out.join('\n');
}
