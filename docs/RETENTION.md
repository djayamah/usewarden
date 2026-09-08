# Why would anyone still have this installed in three months?

> Written 2026-08-26. Every claim about a competing tool is from a primary source, dated below.
> This document is deliberately unkind to usewarden where the evidence is unkind to usewarden.

The question this answers is **not** "does it work". That has been asked for eleven phases and the
answer is yes. The question is retention: at week 4 and week 12, is this still installed, and why.

---

## 1. What actually makes a developer tool survive

Five comparable tools, and the mechanism that decides their fate.

| Tool | Why people keep it | Why people rip it out |
|---|---|---|
| **uBlock Origin** | Works silently. Zero configuration. The value is continuous and needs no attention, and the badge counter is *pull* — you look when curious, it never interrupts. | Almost never removed. When it is, it is because a site broke and the fix was not obvious. |
| **pre-commit / husky** | Catches the embarrassing thing before a colleague sees it. Runs at a moment the developer already stopped. | **Friction and false positives.** And `--no-verify` exists, so the moment it is annoying it is bypassable — after which it is decoration. ([systemshardening.com](https://www.systemshardening.com/articles/cicd/pre-commit-security-hooks/), [dev.to](https://dev.to/osalumense/why-you-should-care-about-pre-commit-hooks-and-how-husky-makes-it-easier-4im4)) |
| **gitleaks** | One real catch pays for the year. | Allowlist maintenance. Test fixtures and docs examples trip it, and the fix is upfront `.gitleaks.toml` work the user did not sign up for. ([decryptiondigest.com](https://www.decryptiondigest.com/blog/prevent-developers-pushing-secrets-git-pre-commit-gitleaks-guide)) |
| **Dependabot** | Genuine CVE coverage nobody wants to do by hand. | **The canonical alert-fatigue failure.** Go's former security lead publicly argued teams should turn it off: it opened thousands of PRs against unaffected repositories and "trained developers to ignore security alerts altogether". ([devclass.com, 2026-02-26](https://www.devclass.com/security/2026/02/26/github-dependabot-is-a-noise-machine-and-should-be-turned-off-says-go-library-maintainer/4091858)) |
| **MartinLoop** | The closest live competitor. Budgets, stop rules, verifier gates and **signed run receipts** for agent runs; claims $2.30 vs $5.20 on a benchmark run. Retention comes from a number on an invoice. ([martinloop.com](https://martinloop.com/), Apache-2.0, `npm i -g martin-loop`) | Wraps the run, so it only governs runs you launch through it. |

**The pattern is one sentence: a tool that interrupts must be right almost every time, and a tool
that never interrupts must be worth looking at.** uBlock is the second kind. Dependabot tried to be
the first kind and failed. usewarden is currently *neither* — it is silent, and there is no reason
to look at it.

That, not correctness, is the retention problem.

---

## 2. The honest comparison against Claude Code's own controls

This section exists because a reader will ask it, and because getting it wrong in our favour is the
fastest way to lose the argument. Sources: [Configure permissions](https://code.claude.com/docs/en/permissions)
and [Claude Code sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing), both read 2026-08-26.

| What usewarden blocks | Native equivalent | Honest verdict |
|---|---|---|
| `.env` reads | `Read(./.env)` deny rule — but it covers **Claude's file tools**, not the shell. `cat` and `head` are built-in read-only commands that "run without a permission prompt in every mode" ([permissions](https://code.claude.com/docs/en/permissions#read-only-commands)), so stopping them needs a blunt `Bash(cat *)` rule. | **CORRECTED 2026-08-26 — usewarden is ahead here.** The earlier version of this row claimed the native rule also covered `cat`/`head`/`sed` in Bash. The documentation does not say that. usewarden has a separate structural check that blocks any unrecognised command naming a credential file (`src/engine/layer1.ts:221`), which exists because a real session reached one with `sed`. It has 3 genuine catches in the record. |
| Reads under `~/Documents`, `~/.ssh` | Deny rules take `~/`-relative and `//` absolute paths in user settings. | **Native is equal — for the file tools.** Measured: usewarden blocks these via `Read`/`Write`/`Edit` (2/2) and **not** via `cat`, `head` or a Python one-liner (0/3), because the forbidden-path check reads `filePath` and a Bash event carries a command instead (`src/engine/layer1.ts:75`). Native has the same shell-shaped hole. Neither tool covers it. |
| `rm -rf` outside the repo | `Bash(rm *)` deny. Matches past env assignments (`FOO=bar rm -rf`). | **Native is equal**, and blunter, which is arguably safer. |
| Force-push to `main` | `Bash(git push --force *)` deny. | **Native is equal.** |
| Writes outside the project | Working-directory confinement, **plus** an explicit check of `>`, `>>`, `2>` redirection targets, **plus** an OS sandbox (macOS seatbelt / Linux bubblewrap) that blocks writes outside cwd for Bash and all child processes. | **NATIVE IS BETTER, and by a lot.** See below. |

### The case where native wins outright, and we should say so

usewarden deliberately does **not** match shell redirection — `docs/FALSE-POSITIVES.md` explains
that matching `>` would fire on every legitimate redirect, and a rule nobody can live with is a
rule that gets disabled. That reasoning is sound and the gap is honestly recorded.

But Claude Code **does** check redirection targets as file writes, and the OS sandbox enforces the
boundary below the agent entirely — so it also catches the Python or Node subprocess that opens a
file itself, which **neither** usewarden nor native deny rules can see.

**Measured, not inferred** (`node scripts/probe-native-gap.mjs`, transcript in
`verification/native-comparison/01-what-fires.txt`): out of scope by shell redirect, **0 of 3
blocked**; out of scope from a subprocess opening the file itself, **0 of 2 blocked**. The same
probe confirms the other direction — 5 of 5 command-shaped cases blocked, and 1 of 1 out-of-scope
write blocked when it arrives through the agent's own `Write` tool.

**Conclusion a single-agent Claude Code user should hear from us rather than discover:** for
*blocking*, native controls plus `/sandbox` are as good as usewarden and in one important respect
better. If blocking is all you want, and Claude Code is all you run, you do not need this.

### What native does not give, and cannot easily

1. **A durable, queryable record.** The sandbox notifies you "immediately"; the documentation
   describes no persistent log. A permission denial is a moment in a transcript you will never scroll
   back to. usewarden has **57 incidents across 22 real sessions over 6 days** on this machine, still
   readable today, with the command, the rule and the timestamp. Nothing native produces that —
   and re-reading them is what produced §4 below, which is the most useful thing in this document
   and could not have been written without them.
2. **One policy across six agents.** Deny rules are Claude Code's. Cursor, Gemini CLI, Copilot CLI,
   Codex and OpenCode each have their own model or none. usewarden writes one policy to all of them.
3. **Drift** — comparing what the agent is *doing* against the goal it was *given*. There is no
   native equivalent, and 4 of the 57 real incidents here were `judge.drift`.

**So the defensible pitch is not "we block things Claude Code cannot". It is "we are the only
thing that remembers, and we are the only one policy your five agents share."**

---

## 3. Ranked: what most raises the odds this is still installed at week 12

Effort is rough implementation time. Confidence is that the change moves retention.

| # | Change | Effort | Conf. | Why |
|---|---|---|---|---|
| **1** | **A pull digest of real sessions — `usewarden week`.** The record is the only unduplicated asset and *nothing surfaces it*. A user has no reason to ever run `usewarden`. Give them one command worth running, that answers "what did my agents actually do", real sessions only, no fixtures, no demo. | S | **9** | This is the uBlock badge. It converts a silent tool into one with a reason to be looked at, without becoming a notification. |
| 2 | **Make `status` survive the agent rewriting its own config.** Shipped this run (D-243). Before it, usewarden reported UNPROTECTED while protecting, told the user to run `init`, and `init` then doubled every hook. | — | 10 | A tool that says it is not working gets uninstalled. This was the single largest retention risk in the product and it was live. |
| 3 | **Say §2 out loud in the README.** State plainly that for a single-agent Claude Code user, native deny rules plus `/sandbox` cover the blocking, and that usewarden's claim is the record and the multi-agent reach. | S | 8 | Credibility compounds. A reader who discovers this themselves stops trusting everything else we said. Touches published claims, so it is the founder's call, not an autonomous edit. |
| 4 | **First-catch moment.** The receipt only exists at session end, and `demo` is synthetic. The first *real* catch is the moment a user decides this is real — and today it passes silently into a database. | M | 7 | Retention is decided in week 1, by one memorable event. |
| 5 | **Prune Layer-1 rules that only duplicate native deny rules.** `sudo`, `chmod-777`, `curl-pipe-shell` are each one deny rule away natively, and each is a false-positive surface. | M | 6 | Fewer, better rules. Every rule that fires wrongly spends credibility we need for the rules that matter. |

## 4. What six days of real firings actually say — added 2026-08-26

The ranked list above was written from reasoning. This section is written from the record, and it
disagrees with the list.

Every one of the 57 real incidents was re-read and classified by whether the shell was actually
about to do the thing, or whether the dangerous words appeared only inside a heredoc body or a
quoted argument that the command was writing as text. The classifier is
`scripts/classify-incidents.mjs`; it prints every case it calls a false positive so the
classification can be checked rather than believed. Transcript:
`verification/false-positive-audit/01-classification.txt`.

| | Count | Share |
|---|---|---|
| Fired on a real command | 11 | 19% |
| **Fired on TEXT about a command** | **35** | **59%** |
| File-tool event carrying a real path | 7 | 12% |
| Drift, and the credential-file-via-shell check | 6 | 10% |

**And the second axis, which the record turned out to be unable to supply.** Reporting the 35 as a
verdict on the *shipped* product would charge it for defects that may already be fixed — the engine
changed during the six days the record covers (D-139, 2026-08-24). So each stored command was
replayed through today's engine. The result:

| Of the 35 that fired on text | |
|---|---|
| no longer fire | **0** |
| would still fire | **1** |
| **UNREPLAYABLE** | **34** |

**The record cannot answer the question.** `incidents.attempted` holds a *display rendering* of the
command — `oneLine()` collapses newlines to pilcrows so a heredoc cannot tear an incident card
apart — and it is truncated for storage. So a heredoc's closing delimiter is usually missing, and
no parser can judge what the shell would have done. Restoring the newlines is possible; restoring
the truncated tail is not.

Counted as UNREPLAYABLE rather than as either a pass or a failure, per §4.4: *"a control whose
state could not be checked is reported as UNVERIFIED and counted against the total."*

**This is the most useful thing the audit produced, and it is about the record rather than the
rules.** `docs/RETENTION.md`'s whole argument is that the record is usewarden's only unduplicated
claim. A record that cannot be replayed can tell you what happened and cannot tell you whether your
fix worked — which is half of what a record is for. **Storing the command as it was, and rendering
it for display, is now the highest-value change to the record itself.** It is a schema change and
it is not attempted here; it is named with its evidence.

**Per rule:**

| Rule | Real | On text |
|---|---|---|
| the registry-release rule | **0** | **14** |
| the recursive-delete rule | 6 | 13 |
| the credential-file rule | 3 | 2 |
| the force-push rule | 0 | 2 |
| the privilege-escalation rule | 0 | 2 |
| the download-and-run rule | 0 | 1 |
| `scope.forbidden_paths` (file tool) | 4 | — |
| `scope.allowed_paths` (file tool) | 3 | — |

### Three conclusions, and they change the ranking

**1. The most-fired command rule in the product has never once been right.** Fourteen firings,
zero real invocations. Every one was an agent writing a document, a commit message or a decision
log whose text named the command. D-247 recorded this at **confidence 6** that it was worth acting
on at all, and named what would settle it: *"one report of a user hitting this"*. It is settled —
and it was settled again live, three times, during the run that wrote this section, one of which
blocked the edit documenting the problem. The surviving class is now named precisely rather than
described as a general annoyance:

  - **a heredoc consumed by a non-shell interpreter** — `python3 - <<'PY'`, which is the single
    most common way an agent edits a file. The body is Python source, not shell, but it is matched
    against shell deny patterns. Stripping is correctly skipped because the opener names an
    interpreter, and that guard exists for `cat <<EOF | bash`.
  - **the dangerous text as a quoted argument** — `grep -n 'npm publish' CLAUDE.md`. Already
    documented as not fixed, and unchanged.

The first of those is fixable without weakening anything, and is now the concrete form of item 5.

**2. The rules that were right every time read a PATH, not a command string.** All seven file-tool
blocks were genuine, including the four reads of the operator's private notes that are the single
clearest piece of value in the whole record. Nothing about a path needs to be told apart from
prose. That is the shape of a rule worth having, and it is an argument for narrowing Layer 1
toward path-shaped rules rather than adding more text-shaped ones.

**3. This reorders item 5.** "Prune Layer-1 rules that only duplicate native deny rules" was ranked
fifth at **confidence 6**. It is now the highest-value change available, because the case is no
longer "these are redundant" — it is "these are actively wrong at a rate that would get the tool
uninstalled". A rule with a 100% false-positive rate over six days is not a duplicate of a native
control; it is a liability the native control does not have, because a native `Bash(npm publish *)`
rule matches at a command position rather than anywhere in the text.

**What this does NOT say.** It does not say Layer 1 is worthless: the recursive-delete rule was
genuinely right six times, and the file-tool rules were right seven times out of seven. It says
the *text-matching* rules are the problem, and that the fix is either a command-position anchor or
deletion — not another rule.

---

### Something already built that does not earn its place

**`context.warn_pct`.** It is in the default policy and it *cannot fire*, because no agent reports
context fill to a hook — the receipt prints "context unavailable" and says so in words. D-224 already
took it out of the defaults and `tests/policy-inputs.test.ts` guards against a rule shipping enabled
with nothing to populate it. That was the right call and it should stay cut, not revived: a rule
that cannot fire is a claim the product cannot keep.

**A weaker case: `demo`.** It is genuinely the best 60-second explanation of the product. But it
manufactures the exact experience item 4 says must be real, and a user who has seen four synthetic
cards may read their first real one as more of the same. Keep it; do not let it substitute for
item 4.

---

## 4b. The ranked list, re-ranked — 2026-08-26

The list in §3 was written from reasoning, before the record had been read. Six days of real
firings moved three of the five, and one of the moves is a **cut**.

| Was | Now | Item | What changed |
|---|---|---|---|
| 1 | **done** | `usewarden week` | shipped |
| 2 | **done** | `status` survives a config rewrite | shipped (D-243) |
| 3 | **done** | say the native comparison out loud | shipped this run, authorised by the founder, and one row of it was wrong in *our* favour (D-251) |
| 5 | **1** | **prune / narrow the text-matching rules** | promoted from confidence 6. The case is no longer "these duplicate native rules" but "these are wrong at a rate that gets a tool uninstalled". Built this run for the common shape (D-259) |
| — | **2** | **store the command as it was, render it for display** | NEW, and it did not exist before the audit. The record cannot be replayed (D-258), which costs it half its purpose |
| 4 | **cut, for now** | the first-catch moment | see below |

### Item 4 is cut until item 5 is finished, and the evidence is item 5's

Item 4 makes a user's first *real* block memorable, on the reasoning that retention is decided in
week one by one event. That reasoning is sound. It is also an amplifier, and an amplifier is worth
exactly as much as the precision of the thing it amplifies.

Over six days of real traffic here, **35 of 59 blocks fired on text rather than on a command**. The
shape that survives longest is the `python3` heredoc — which is *the* way an agent edits a file, so
it is disproportionately likely to be among a new user's earliest events. Building a memorable
first-catch experience on top of that means the memorable event is a false positive, and the thing
week one decides is that the tool is wrong.

**So the order inverts: item 5, then item 4.** The ranked list had 4 above 5 at confidence 7 versus
6, and the inversion comes entirely from data that did not exist when the list was written. Item 4
gets no work until a replay of the record shows the residue is gone — which needs item 2 above
first, because today no such replay is possible.

### What was cut outright, and why

**`context.warn_pct`** stays cut (§3 already argued this, and nothing here changes it).

**Nothing else was cut.** In particular the rules with zero real catches — force-push, privilege
escalation, download-and-run — are **not** deleted despite firing 0/5 correctly here. Six days on
one machine is n=1, and deleting a security rule because it has not yet caught anything on a single
developer's laptop is exactly the overfit this document warns about elsewhere. They are narrowed by
D-259 along with everything else, and left in.

---

## 5. What was built this run, and why that one

**Item 1, `usewarden week`.**

- It is the only item that is both top-ranked and buildable inside one run.
- It touches no published claim — purely additive, no README or npm description change, so it stays
  inside what an autonomous run may do.
- Item 2 was already built this run as a defect fix (D-243).
- Item 3 changes published marketing copy and is the founder's decision.
- Items 4 and 5 are larger and would each want their own sabotage cases.

**It is a pull command, not a scheduled push, and that is deliberate.** D-230 cut the weekly signal
on the grounds that anything firing on a schedule is a notification whatever it is called, and that
the receipt already serves the moment a user looks. That reasoning stands and is not reversed here.
D-230's own closing sentence names this exact escape hatch: *"if users ask for a digest after launch
it is a small feature, and it should be pull rather than push even then."* This is the pull form.
No daemon, no scheduler, no mid-session output, nothing that speaks unless asked.

---

## 6. Should the default be project-scoped? — recommendation, 2026-08-29

**Recommendation only. Nothing here is implemented.** Changing default scope changes published
behaviour for everyone on 0.1.0 and 0.1.1, and that is the founder's call.

The occasion is `docs/CHURN-2026-08-27.md`: the only person who has ever run this product against
sustained real work uninstalled it, and 32 of the 40 blocks it fired against his other projects in
the preceding 72 hours were ones no competent developer would have wanted.

### 6.1 What the default actually is today, stated exactly

`usewarden init`, with no flags, does two things that point in opposite directions:

| | scope |
|---|---|
| **Where the hooks are registered** | the **user** layer — `~/.claude/settings.json`, `~/.gemini/settings.json`, `~/.codex/hooks.json`. Every agent session on the machine, in every directory, forever (`src/install/detect.ts`, `agentTargets` defaults to `'user'`) |
| **What the policy permits** | `allowed_paths: [repoRoot]` — *the single repository you happened to be standing in when you ran init* (`src/policy/schema.ts:253`), frozen into `~/.usewarden/usewarden.yaml` at that moment |

**Enforcement is machine-wide; permission is one directory.** Every other project on the machine
is out of scope for writes from the instant of installation, including projects that did not exist
yet. `--project` exists, but it is opt-in and is mentioned in `--help` and in the error you get
when no agent is detected.

That mismatch is the engine of the churn, and not only through the obvious route. Because
`allowed_paths` is frozen and machine-wide, a user who wants "don't wander into my other work"
cannot express it by scoping the session — so they express it by hand-enumerating their other
projects into `forbidden_paths`. That list is correct on the day it is written and wrong the first
day they work in one of those projects. Seventeen of the forty blocks are exactly that: a
repository on the forbidden list *and* on the allowed list, with the veto winning silently.

### 6.2 How comparable tools scope by default — primary sources, checked 2026-08-29

| Tool | Default scope | Source |
|---|---|---|
| **pre-commit** — the closest analogue: a tool whose whole job is installing a guard hook | `pre-commit install` writes into **that one repository's** `.git/hooks`. Machine-wide requires a *different* command, `pre-commit init-templatedir`, **plus** an explicit `git config --global init.templateDir`. Even then it is inert where not opted in: a cloned repo with no `.pre-commit-config.yaml` prints *"config file not found. Skipping pre-commit"* | [pre-commit.com](https://pre-commit.com/) |
| **Claude Code** | Both offered, neither imposed. `~/.claude/settings.json` is labelled *"You, every project"*; `.claude/settings.json` is *"Everyone in the project"* and is the shareable, committable one | [settings](https://code.claude.com/docs/en/settings), [hooks](https://code.claude.com/docs/en/hooks) |
| **Gemini CLI** | Four layers; the **workspace** file `.gemini/settings.json` *overrides* the user file `~/.gemini/settings.json`. Project beats machine | [configuration](https://google-gemini.github.io/gemini-cli/docs/get-started/configuration.html) |
| **Cursor** | `.cursor/hooks.json` (project) and `~/.cursor/hooks.json` (user), both first-class | [Hooks](https://cursor.com/docs/hooks) |
| **Codex CLI** | The sharpest precedent. Under `workspace-write` the writable set is **the current working directory**, plus `/tmp` and `$TMPDIR`, plus any configured `writable_roots`; the rest of the filesystem is read-only | [Configuration Reference](https://developers.openai.com/codex/config-reference), [Sandbox](https://developers.openai.com/codex/concepts/sandboxing) |

Two patterns, and usewarden matches neither:

1. **Nobody freezes the working scope at install time.** Codex derives it from *this session's* cwd,
   every session. Gemini and Cursor let the project the user is in speak for itself. usewarden
   captures one directory once and applies it to every session on the machine thereafter.
2. **Machine-wide is opt-in and inert where not opted in.** pre-commit's global mode still does
   nothing in a repository that has not opted in by carrying its config file.

Codex supplies one more detail worth taking verbatim: `/tmp` and `$TMPDIR` are **always** writable
under `workspace-write`. usewarden has no such exemption anywhere in `src/engine` or `src/policy`,
which is why it blocked the agent's own per-session scratchpad — a directory the harness created,
that the user never chose and cannot see.

### 6.3 The trade-off, stated plainly

Project scope loses cross-repository catches, and those were the most valuable real finds. In the
churn window the single genuinely valuable catch was exactly one: an unattended agent working in
one repository read a file in a second repository that its own instructions had declared off
limits *even to read*. Over the whole record the same class includes an agent working in a private
notes directory reaching into a different directory's secrets file, and one reaching out to write
a script outside the tree it was working in.

**But look at which half of `scope:` produced them.** Every cross-repository catch in the record
came from `forbidden_paths` or from an `allowed_paths` check against the **session's own** root.
Not one came from the frozen install-time repository list. Meanwhile every unwanted block traced to
scope came from that frozen list, or from `forbidden_paths` entries the user only wrote *because*
the list was frozen.

**The two halves of `scope:` want opposite defaults, and shipping them with the same one is the
defect.** `forbidden_paths` is a statement about the machine and should stay machine-wide.
`allowed_paths` is a statement about the task and should follow the session.

### 6.4 Recommendation

**Do not simply flip the default to `--project`.** That would take machine-wide coverage away and
lose the credential and off-limits catches with it — the one class that is genuinely working.

**Recommended instead: keep hooks at the user layer; make `allowed_paths` session-derived.**

1. **`allowed_paths` defaults to the repository root of the session's own cwd**, resolved at hook
   time rather than frozen at init — the Codex `workspace-write` model. An explicit
   `allowed_paths` in the policy continues to mean exactly what it means today, for anyone who
   wants to pin it.
2. **`/tmp`, `$TMPDIR` and the agent's per-session scratchpad are always writable**, as Codex does.
3. **`forbidden_paths` is unchanged and stays machine-wide.** This is where the value is.
4. **`~/.usewarden/` is always writable**, so the escape hatch is not behind the lock.

What this buys, measured against the churn window rather than argued: Class A (17 blocks) stops
being something a user is *pushed toward* mis-writing, and Class E (3 blocks) disappears outright.
The one real catch survives untouched, because it was a `forbidden_paths` catch. So does every
credential catch.

What it does **not** fix, said plainly so it is not claimed: the Class A message bug and the
absence of conflict detection between the two lists are separate defects
(`src/engine/layer1.ts:80` and `:86`). A path in both lists would still lose silently, and would
still be described to the user as a credential. Scope defaults are not a substitute for those.

**Confidence 8.** What would change it: evidence that a user's *intent* routinely spans sibling
repositories in one session — a monorepo split across checkouts, or a tool repo edited alongside
the project that consumes it. Session-derived scope would obstruct that, and the honest answer
there is `writable_roots`, which is what Codex reaches for too.

---

## §6 UPDATE — 2026-09-08: the scope recommendation is settled and half of it is implemented

§6 recommended, and did not implement, session-derived `allowed_paths` with `forbidden_paths` left
machine-wide (D-264). It could not be settled at the time because the record could not be replayed.

It can now. **D-264 was right, and it is measured rather than argued**: session-derived
`allowed_paths` takes precision from 90.9% to 94.3% with coverage unchanged at 50/50, and it is
implemented. Making `forbidden_paths` project-scoped as well — the symmetric move the churn
complaint points at — costs **22 of 50 real catches to remove 2 false positives** and is refused.

The full verdict, with the table and the trade-off stated plainly, is at the end of
`docs/CHURN-2026-08-27.md`. Item 3 of §4b ("prune / narrow the text-matching rules") is done:
D-279, precision 63.3% -> 86.2% with no coverage loss.
