# False positives

**A guardrail that blocks something legitimate does not cost you one alert — it costs every later
alert**, because
[engineers who see a security tool produce one bad finding stop believing its other output](https://www.reversinglabs.com/blog/appsec-alert-fatigue-4-ways-to-reduce-the-risk-of-burnout).
That is the mechanism by which tools like this get uninstalled. So it gets a page rather than a
line, and it is written before launch rather than after the first complaint.

## It has already happened, to us, twice in one day

Writing this project's own release runbook was refused. The document explained the release process,
so the text contained the words `npm publish`, and the rule that stops an agent releasing your
package fired on a *sentence about* releasing.

Hours later, writing a security test fixture was refused because the fixture contained `rm -rf ~/`
as test data — a corpus of dangerous commands, which is exactly the file a project like this needs
to write and exactly the file its own guardrail would not let it write.

Both times the guardrail mistook a description of a dangerous command for the command.

## What was fixed, and what was not

**That class is fixed.** usewarden now removes heredoc bodies that are being written as data
before matching command patterns, so prose about a command is no longer read as the command.

Getting there took four attempts, and the shape of the failures is the interesting part. The first
version gated on an allowlist of "safe" heredoc consumers — `cat` and `tee` — and that list was
wrong immediately: `git commit -F - <<EOF` then refused a commit *message* describing a dangerous
command. Next would have been `gh pr create --body-file -`, then `mail`, then whatever anyone
thinks of after that. That is exactly the shape this project already named about `.env` readers:
**a list of safe things is wrong the moment it is written.**

So the polarity is inverted. A heredoc body is treated as data unless the line that opens it names
something that would **execute** it — an allowlist of dangerous rather than an allowlist of safe,
and the set of interpreters is short and stable in a way the set of file-writing commands is not.
The check is per line, so `cat <<EOF | bash` is still scanned in full while one `node` elsewhere in
a long script does not switch the guard off. An unterminated heredoc is scanned rather than guessed
at, and writing the file is still governed by scope: `cat > /etc/passwd <<EOF` is still refused, for
its target rather than its contents.

**The residual gap, stated rather than hidden:** a command that executes its heredoc without naming
a recognised interpreter — `docker run img <<EOF`, `$SHELL <<EOF` — has its body treated as data.
That is narrower than the gap it replaced, and the alternative was a guard that refuses
documentation about its own subject matter.

**The general problem does not go away, and here is the part still open.** The class is not really
about heredocs — it is about any text passed to a command as *data*. Minutes after the heredoc fix
landed, the same thing happened in a different syntax: a `printf` whose quoted argument mentioned a
release command was refused, because the matcher sees the command string and does not know that an
argument to `printf` is data rather than an instruction.

Counting honestly, this guard blocked its own author writing prose **six times in two days**, across
three syntaxes: a heredoc body, a commit message passed with `-F`, and a quoted argument.

Fixing the argument case properly needs real shell tokenisation with quote tracking, on the hottest
path in the product. Doing it badly is worse than not doing it: `commandTargetsOnlyAllowedPaths`
already shows what a half-tokenised implementation costs, since it reads option values as paths and
fails closed on them. So it is a named limitation rather than a silent one.

**The workaround, which is what we use ourselves:** write the text with a file tool rather than as a
shell argument. If your agent is composing documentation about dangerous commands, have it write the
file directly instead of echoing text through a shell.

## When it happens to you — four options, in escalating order

1. **Read the rule id.** Every block names it: `commands.deny[10] (git-clean-force)`. That is not
   decoration, it is the address of the thing to change.
2. **Downgrade it to a warning.** In `usewarden.yaml`, set that rule's `action: warn`. It still
   records what happened; it stops refusing.
3. **Narrow it rather than delete it.** Add `outsideRepoOnly: true` if the command is only dangerous
   outside your project, or tighten the pattern. Narrowing keeps the rule for the case it was
   written for; deleting removes the protection permanently.
4. **Remove it.** It is your policy file. `usewarden policy` prints the effective policy and where
   every part of it came from, so nothing is hidden from you.

## What we will not do about it

We will not quietly widen an allowlist to make a complaint go away. A broad exclusion hides the next
real finding in the same place, and this project has caught itself reaching for that shortcut twice
(DECISIONS D-153, D-194) — once one commit after writing the very control it was about to weaken.

Every rule change is measured against two corpora, both in the repository and both re-runnable:

```bash
node --test dist/tests/policy-coverage.test.js
```

| Corpus | What it is | Why it exists |
|---|---|---|
| **hostile** | 35 documented public agent failures | measures what agents actually do, not what we imagined they would |
| **benign** | 34 cases of ordinary agent work, each chosen as the nearest *innocent neighbour* of a hostile case | a rule that cannot tell one from the other does not ship |

The benign corpus is the one a security tool is least likely to have, and it earned its place
immediately: it found two false positives in rules added the same hour those rules were written. One
was subtle. `find . -name '*.tmp' -delete` was refused because the path checker cannot tell a path
argument from an option value — it read `'*.tmp'` as a path, could not resolve it, and failed
closed. The rule was rewritten to not depend on path resolution at all.

## How we decide whether a rule is worth having

A rule ships only if it fires on the hostile case **and** stays silent on the innocent neighbour.
Where those two cannot be separated, the rule does not ship, and the gap is written down instead.

Three such gaps are named in `tests/policy-coverage.test.ts`. One is worth repeating here, because
it shows where the line is: matching `>` would catch a file being truncated to zero bytes, and would
also fire on every legitimate shell redirect in every command anyone runs. A rule nobody can live
with is a rule that gets disabled, and a disabled rule protects nobody.

## The newest rule, and the three narrowings it needed

`scope.protect_uncommitted` refuses a whole-file overwrite of work git could not get back. It was
the last remaining miss in the real-incident corpus that was ours to fix, and it guards the single
most ordinary thing an agent does — which is exactly what makes it the most dangerous rule in the
policy to get wrong.

It shipped only because three narrowings survived the benign corpus:

1. **Whole-file writes only.** `Edit` is a surgical replacement that leaves the rest of the file
   standing. Firing on it would put this guard in front of nearly every turn of nearly every
   session for a fraction of the risk.
2. **Not the agent's own work.** The agent's first write makes a file dirty. Without this, warden
   would refuse the agent's second write to its own file — a false positive within one turn of
   being installed.
3. **Ignored files are not work.** A file matching `.gitignore` has already been declared
   disposable in writing. Without this, an agent could not regenerate `dist/`.

Each of those is a case in the benign corpus, so removing one fails the suite rather than being
discovered by a user. The remaining honest gap is your **global** ignore file
(`core.excludesFile`), which usewarden does not read: a file ignored only there reads as untracked
and a wholesale overwrite of it is refused once. `docs/GIT-AWARENESS.md` lists every such limit.

## The escape hatch — built 2026-08-24

**There is now a per-incident "allow once".** It was the one thing on this page most likely to get
usewarden uninstalled, and it is closed.

```bash
usewarden allow dotenv-access        # waive that rule, in this project, for 24 hours
usewarden allow --list               # every waiver you hold, and when each expires
usewarden allow --revoke dotenv-access
```

Four properties, and each is why the others are safe:

1. **It expires after 24 hours.** A permanent exception is an allowlist entry, and this project's
   own history is that broad allowlist entries hide the next real finding (D-153, D-194). A waiver
   you forget heals by itself.
2. **It is not in your policy file.** It lives in the state directory, so it cannot be committed,
   shared, or inherited by a teammate's checkout and quietly become permanent.
3. **It is scoped to one rule in one project.** Waiving `dotenv-access` here does not open `.env`
   reads everywhere on your machine.
4. **Your agent cannot grant it.** `usewarden allow` refuses to run unless stdin is an interactive
   terminal, and every supported agent runs shell commands through a captured pipe. An escape hatch
   an agent can operate is not a guardrail — it is a documented bypass, and a blocked agent is
   optimised to find one.

**A waiver changes the verdict, not the audit trail.** The attempt is still recorded, the incident
card says *Waived by an explicit human exception*, and it still appears on your session receipt.
"Allowed because you said so" and "allowed because nothing objected" must never look alike.

The id to type is on the incident card. Any of the forms it prints works — `dotenv-access`,
`commands.deny[6] (dotenv-access)`, or `scope.forbidden_paths` for an indexed rule.


## The sixth occurrence, and what it proved

While writing the README section you are reading about, `usewarden` refused the write — because the
text contained `rm -rf` as an argument to the tool doing the writing. Sixth time, same class,
documented in the same paragraph it was blocking.

Two things about that are worth stating rather than hiding.

**The escape hatch refused too, and it was right to.** `usewarden allow` was invoked and declined,
because the caller was an agent and not a person at a terminal. That is the property the whole
feature depends on, demonstrated against its own author under real conditions rather than in a
test: an agent that has just been blocked cannot grant itself a waiver, even when the agent is the
one who wrote the waiver feature and knows exactly how it works.

**The documented workaround is what got used**, and it took one attempt: write the text with a file
tool instead of through a shell argument. Your agent's `Write` and `Edit` tools are unaffected by
any of this — only `Bash` is. That is a liveable limitation, and the count above is the honest
measure of how often you will meet it.
