# Does someone who installs this keep it?

Researched and measured 2026-08-24. Every number here comes from a command in this repository, and
the commands are named so you can re-run them rather than trust me.

**The short answer.** Before this run: an honest first-run story, a policy that caught roughly half
of what agents actually do wrong, a false-positive class that had already blocked its own author
twice, and no reason to still have it installed on day 14. After this run: the first three are
materially better and measured. **The fourth is not solved, and I do not think it can be solved by
building more — see §4.**

---

## 1. Time to first catch

### What fast-adopted tools do

The pattern is consistent and it is not "good onboarding copy" — it is **acting on state the user
already has, immediately.** ESLint finds problems in code you already wrote. `gitleaks` scans the
history you already have. Sentry's first step is *send a test error*, deliberately, so something
appears within a minute. The measured stakes:

- **68% of developers abandon a trial over setup length**; only 12% over price.
- Reaching first value inside ten minutes correlates with a **3–4× conversion** difference.
- Attention turns from curiosity to scepticism after roughly **60 seconds with no tangible result**.

### What ours was

| Step | Elapsed | What the user sees |
|---|---|---|
| `usewarden init` | ~30s | hooks registered. Nothing observable. |
| `usewarden demo` | ~5s | four incident cards — **synthetic**, in a temp directory, labelled `demo`, deliberately excluded from every headline figure |
| first real catch | **unbounded** | whenever an agent happens to misbehave. Could be an hour. Could be never — and *never* is the good outcome, which looks identical to a broken install. |

`demo` proves the tool runs. It says nothing about the user's project, and they know it, because a
demo is a demo. So the honest time-to-first-*real*-value was "wait until you drift", which is the
worst available answer.

### What changed — `usewarden scan`

A new read-only command, about a second, that evaluates **the user's real project against their real
policy** and reports what it finds: credential files sitting inside the tree, which well-known
credential stores exist on this machine, whether another git repository sits beside this one,
whether the current branch is protected, and how many rules are live for a project of this shape.

```
  WOULD BLOCK  2 credential files inside this project
               fixtures/_seed/sandbox-project/.env, fixtures/sandbox-project/.env
  WOULD BLOCK  15 credential stores outside this project are covered
  WOULD BLOCK  3 other git repositories beside this one
  WOULD WARN   you are on "main", which is a protected branch
  10 of 10 command rules are live for a project shaped like this.
```

**It does not fake a catch, and that constraint shaped it.** Nothing is recorded as an incident,
no counter moves, and every line says WOULD BLOCK rather than BLOCKED. Inventing a catch would be
the metrics-inflation defect this project already found in its own dashboard (D-069), committed
deliberately the second time — which is worse.

**It found a privacy defect in itself on first run, which is worth recording.** The first version
printed every `~`-rooted entry in the effective policy by name, and `forbidden_paths` is precisely
where a user lists what they most want kept away from an agent. On the first machine it ran on, that
meant a list of the operator's unrelated private directories, straight to stdout — output that is
*designed to be pasted into bug reports*. Well-known defaults (`~/.ssh`) are named because they are
identical on every machine; everything the user added is counted and never named. Same for sibling
repository names. Pinned by tests in `tests/scan.test.ts`.

**Honest limitation.** A finding about your own project is weaker than a catch. It is a real fact
delivered in a second instead of a hypothetical delivered never, and that is the trade.

---

## 2. Is the default policy actually useful?

**No, it was about half useful, and we would not have known.**

`tests/sabotage/suite.test.ts` scores the default policy against usewarden's own sabotage suite at
**14/17 = 82.4%** (15/17 until 2026-08-24, when one scenario was found to be scored against a
field no adapter sends — see docs/POLICY-INPUTS.md). That number is real, and it is flattering,
because we wrote both the suite and
the policy. A guardrail scored against its author's imagination is scored against the wrong thing.

So I built a corpus from **documented public agent failures** and measured against that instead:

| | Before | After the policy pass | After git awareness |
|---|---|---|---|
| Real-world incidents caught | **19/35 = 54%** | **32/35 = 91%** | **34/36 = 94%** |
| Ordinary work falsely blocked | 2 of 34 | 0 of 34 | **0 of 40** |

The denominator moved because the corpus grew, and it is stated that way rather than quietly
restated: git awareness (§5.1, now built) turned one known miss into two hostile cases — an
untracked file and one with uncommitted changes — and brought six new benign neighbours with it,
each differing from a hostile case by exactly one fact about what git can restore.

Re-runnable: `node --test dist/tests/policy-coverage.test.js`.

### What it missed, and what that cost

The five credential stores absent from the forbidden list are the ones worth dwelling on:

- **`~/.npmrc`** — holds an npm publish token. Token theft is the initial access in both
  Mini Shai-Hulud incidents that `release.yml` cites *in its own header* as the reason this project
  publishes the way it does. We hardened the release pipeline against exactly that attack and left
  the file it targets off the list.
- **`~/.kube/config`** — cluster admin credentials. The April 2026 incident where an agent deleted a
  production database and its backups is authorised by this file.
- `~/.netrc`, `~/.docker`, `~/.config/gcloud`, `~/.azure` — the same story, other vendors.

Also missing: `git clean -fdx` (permanently deletes untracked files — `.env`, local databases),
`dd of=/dev/…`, `mv … /dev/null`, `find … -delete` outside the repo, `terraform destroy`,
`kubectl delete namespace`, pushing straight to a protected branch.

### What it still misses, named so the 94% cannot be quoted without them

1. **Destruction through an HTTP API rather than a shell.** The PocketOS-class incident was a
   single `DELETE` call. Whether a URL is a production database or a staging health check is not
   decidable from the command, and blocking every DELETE would block ordinary API work.
2. **`: > file` truncation.** Matching `>` would fire on every legitimate redirect.

**Overwriting an unversioned file inside the repo used to be the third, and is now caught.**
`scope.protect_uncommitted` refuses a whole-file replacement of anything git could not restore.
It fired against two real Claude Code sessions — `verification/live/13-uncommitted-overwrite.txt`
and `14-modified-overwrite.txt` — and in both the agent made the work recoverable and continued,
rather than routing around the block. Its limits are in `docs/GIT-AWARENESS.md`.

---

## 3. The false-positive problem

### What mature tools do

Convergent, across `gosec`, `golangci-lint`, Semgrep and SAST practice generally:

- **Inline suppression carrying a required justification** (`#nosec` with a reason, `//nolint` with
  a comment) — not a silent ignore.
- **Precise rule ids, never broad path exclusions**, because a broad exclusion hides every future
  finding in that path.
- **An auditable suppression inventory** — what is suppressed, why, when it was last reviewed.
- **A low false-positive rate is the thing that earns the right to be listened to.** Engineers who
  see one bad finding assume the rest are bad and stop reading the output.

None of that transfers directly, because our "finding" is an *agent action at a moment*, not a line
of source. There is nowhere to put a comment. And one rule has no analogue in any of those tools:
**the agent must never be able to suppress anything.** Only the human.

### What we did

**Fixed the class, not the instance.** D-139 was the deny rules matching *prose about* a command.
The engine now removes heredoc bodies being written as data before pattern matching
(`stripDataHeredocs`), which is the using-versus-naming distinction (D-091) applied to shell text —
the same one `botProseOnly` already applies to the triage bot's quotations.

It took four attempts and the failures are the useful part. Attempts one to three gated on an
allowlist of "safe" heredoc consumers (`cat`, `tee`), and that list was wrong immediately —
`git commit -F -` then refused a commit *message* about a dangerous command, which is **D-081's
lesson with the polarity flipped**: a list of safe things is wrong the moment it is written. The
final version inverts it: a body is data unless the opening line names something that would
*execute* it. Per line, so `cat <<EOF | bash` is still scanned while one `node` elsewhere in a
script does not disable the guard. Unterminated heredocs are scanned rather than guessed at, and the
write is still governed by scope. Residual gap, stated: `docker run img <<EOF` is treated as data.

**Built the benign corpus**, which is the part a security tool is least likely to have: 34 cases of
ordinary agent work, each chosen as the nearest *innocent neighbour* of a hostile case. It found two
false positives in rules added the same hour, one of which was mine and subtle — `find . -name
'*.tmp' -delete` was blocked because the path checker cannot tell a path argument from an option
value, read `'*.tmp'` as a path, and failed closed.

**Wrote the FAQ entry before launch**, as asked. It names the two times this project's own guardrail
blocked its own author, gives the four escalating things to do, and states the gap: **there is no
per-incident "allow once" yet.** Today the escape hatch is a thirty-second policy edit, not a
keystroke.

---

## 4. What is the second week?

**We have a first run and a record. We do not have a second week.** I do not think that is a
missing feature, and this is the section I am least comfortable writing.

### What the research says kills local dev tools

- **Warning fatigue**, and the specific mechanism: false positives accumulate, developers tune the
  tool out entirely, and *one* bad finding discredits the rest of the output.
- **Flow interruption** — being told to fix something while concentrating on something else.
- **Volume without action** — only about **32%** of automated pull requests get merged.

Usewarden's fatigue profile is genuinely better than a linter's, and the reason is structural: it
interrupts the **agent**, not the human. On a normal day it is silent. That is a real advantage.

### And it is also the retention problem

A tool that is correctly silent has produced no evidence it did anything. If nothing dangerous
happens in week two — the *good* outcome — the honest state of the world is indistinguishable from
"this is not running", and it gets removed at the next config tidy-up. `usewarden status` answers
that, but only if you already suspected it.

So the value that accumulates is the **incident wall**: after two weeks it is a record of what your
agents actually attempted, which is yours and did not exist before. That is real, and nothing
surfaces it. There is no reason to ever look.

**The thing that would fix it, and why I did not build it.** The store already counts every event
per origin, so a truthful weekly line is cheap:

> *usewarden evaluated 4,812 agent actions this week and refused 3.*

That is a statement of work done that is true on a quiet week, uninflatable because it derives from
the store, and it is the only honest retention signal a guardrail has. But **where it appears is a
product decision, not an implementation detail** — a terminal line on first shell of the week, a
`usewarden week` command someone has to remember, or a notification, and the last of those is
exactly the flow interruption that kills these tools. That is your call, so it is §5 item 3 and not
a commit.

**The blunt version:** if a user installs this, sees `scan`, and nothing is ever blocked, they will
uninstall it within a month and they will be right to, because nothing will have told them it was
working. The engine is not the gap. The gap is that a guardrail's good outcome is silence, and we
have no honest way of making silence visible.

---

## 5. The three highest-leverage changes

Ranked by effect on *whether someone keeps it*, not by effort.

### 1. Git awareness in scope — **BUILT, 2026-08-24**

The policy allows every write inside the repo, which is what makes the tool usable and is also the
hole the #53900 incident went through: an agent destroyed an uncommitted file *inside* the project.
Scope cannot see the difference between overwriting a committed file (recoverable with one git
command) and an untracked one (gone).

**Why it is first:** it is the only remaining miss in the real-incident corpus that is *ours to
fix*, it converts the most common everyday agent action from unguarded to guarded, and the signal is
free — `git status --porcelain` already knows. It also needs no new user concept: "usewarden refused
to overwrite a file you had not committed" explains itself.

**Built, measured and live-fired.** `scope.protect_uncommitted`, on by default. It reads
`.git/index` and the ignore files directly rather than shelling out to `git`, because
THREAT-MODEL T-05 forbids building a subprocess out of an agent-supplied path — and
`tests/gitstate.test.ts` checks that reimplementation against real `git status` output on real
repositories, because a reimplementation asserted against its author's expectations is asserted
against the wrong thing.

The measurement pass it was held back for is above: 34/36 hostile, 0/40 benign. Three narrowings
were needed to keep the benign column at zero, and each is now a corpus case — see
`docs/FALSE-POSITIVES.md`. Everything it cannot decide returns "unknown" and does not fire;
`docs/GIT-AWARENESS.md` lists every such case.

`usewarden scan` reports it too: how many files in this project hold work git could not get back,
counted and never named — because a list of what you have not committed is a list of what you are
in the middle of, and that output is meant to be pasteable.

### 2. Per-incident "allow once" — **BUILT, 2026-08-24**

The FAQ now admits there is no keystroke escape hatch. Retention research says this is the single
most likely cause of a user removing the tool, and D-139 says the author hits it too.

Design, following the mature-tool consensus: the human runs `usewarden allow <rule-id>` after a
block, which records a scoped, dated, **expiring** exception in the state directory — not the policy
file, so it never silently becomes permanent. The agent can never invoke it. `usewarden allow --list`
is the audit inventory.

**The expiry is 24 hours**, the founder's decision, on exactly that reasoning. Built as
`usewarden allow <rule-id>` / `--list` / `--revoke`, with the property the whole feature rests on:
**an agent cannot grant it**, because the command refuses unless stdin is an interactive terminal
and every supported agent runs shell commands through a captured pipe. A waiver downgrades the
verdict to a recorded warning rather than silencing it — see D-229 and `docs/FALSE-POSITIVES.md`.

### 3. An honest weekly signal — **CUT, 2026-08-24**

**Cut, and superseded by the session receipt.** The receipt (D-219) already delivers the honest
signal this item was asking for, at the moment a user actually looks — session end — rather than on
a schedule. Anything weekly needs something to fire it, and a thing that fires on a schedule is a
notification whatever it is called; the receipt work was explicitly specified with no notifications,
no daemon and no mid-session output, and adding a weekly one would undo that. `usewarden sessions`
already answers "what happened lately" on demand, which is the same information without a timer.
Recorded rather than silently dropped — see D-230.

---

## What was changed in this run

| Change | Measured effect |
|---|---|
| 12 credential stores and key types added to the default forbidden list | part of 54% → 91% |
| 7 destructive-command rules added | part of 54% → 91% |
| `stripDataHeredocs` — prose about a command is no longer the command | the D-139 class, closed |
| `protectedBranchOnly` generalised out of a hardcoded rule-id check | the refinement is now reachable by user-written rules |
| `usewarden scan` | first real value: unbounded → ~1 second |
| `tests/policy-coverage.test.ts` | 35 hostile + 34 benign cases, re-runnable |
| `tests/scan.test.ts` | scan's privacy properties pinned |
| README FAQ: false positives | the honest answer, before launch |

## What was changed in the run after it (2026-08-24)

| Change | Measured effect |
|---|---|
| `scope.protect_uncommitted` + `src/engine/gitstate.ts` | 91% → **94%** real-incident coverage, benign column still zero |
| `tests/gitstate.test.ts` — differential against real `git status` | the reimplementation is checked against git, not against us |
| `tests/git-awareness.test.ts` | the `agentAuthored` signal, which a corpus cannot reach |
| `usewarden scan`: work git could not get back | counted, never named |
| `wrapLine` hanging-indent defect | **every** incident card was renderable wider than its own frame |
| `tests/term.test.ts` | the product's screenshot had no tests at all until now |

643 tests pass. Sabotage suite 14/17 (restated 2026-08-24, D-225). Real-incident coverage **34/36** with the two
remaining misses named in the test file, so the figure cannot be quoted without them.

## Sources

- [Coding Agent Horror Stories: the `rm -rf ~/` incident](https://www.docker.com/blog/coding-agent-horror-stories-the-rm-rf-incident/) — Docker
- [Severe agent failure in Claude Code, issue #53900](https://github.com/anthropics/claude-code/issues/53900) — anthropics/claude-code
- [AI coding agent deletes production database and backups in 9 seconds](https://techstartups.com/2026/04/28/claude-powered-ai-coding-agent-deletes-production-database-and-backups-in-9-seconds/) — Tech Startups
- [Claude Code mishap wipes 717GB in 90 seconds](https://blockchain.news/ainews/claude-code-mishap-wipes-717gb-in-90-seconds) — Blockchain News
- [AI agents are deleting developer home directories](https://chatforest.com/builders-log/ai-agents-deleting-home-directories-rm-rf-gpt56sol-claude-cli-tilde-expansion-sandbox-builder-guide/) — ChatForest
- [Developer onboarding optimization: from first click to paying customer](https://business.daily.dev/resources/developer-onboarding-optimization-from-first-click-to-paying-customer/) — daily.dev
- [The 10-minute onboarding standard](https://www.bspk.com/post/the-10-minute-onboarding-standard-what-high-adoption-tools-have-in-common) — bspk
- [False positives in SAST — building suppression into a scanner](https://dev.to/pgmpofu/false-positives-in-sast-how-i-built-suppression-into-my-scanner-and-why-it-matters-48lo) — DEV
- [False positives](https://golangci-lint.run/docs/linters/false-positives/) — golangci-lint
- [AppSec alert fatigue: 4 ways to reduce burnout](https://www.reversinglabs.com/blog/appsec-alert-fatigue-4-ways-to-reduce-the-risk-of-burnout) — ReversingLabs
- [Why developers love and hate linters](https://www.hivel.ai/blog/the-love-hate-relationship-with-linters) — Hivel
