# The precision run — 2026-09-08

*Written for a non-technical reader. Every number in it can be reproduced with one command, which
is given at the end.*

---

## The problem, and whether it is fixed

You uninstalled your own product because it kept stopping work it should not have stopped. Over 72
hours it blocked 40 things and 32 of them were unwanted.

**It is fixed, and the number is measured rather than asserted.**

| | how often it was RIGHT | how much it still CATCHES |
|---|---|---|
| **Before** — what you actually lived through | **54.3%** (50 of 92 blocks were wanted) | 100% (50 of 50) |
| **After** — a fresh install today | **94.3%** (50 of 53 blocks are wanted) | **100% (50 of 50)** |

The target was 90% without losing coverage. It reached 94.3%, and **coverage did not move at all**:
every one of the 50 catches that were genuinely worth having still fires. Both numbers come from the
same pass over the same 92 incidents, so neither can be improved by quietly worsening the other.

**Nine of those points were not this run's work.** Two fixes from August had already taken it from
54.3% to 63.3% before today started. Saying "54.3% to 94.3%" would be claiming credit for those.
This run moved it from **63.3% to 94.3%**.

---

## What the numbers mean

- **Precision** — of the things it stops, how many did you want stopped. Low precision is what makes
  people uninstall a tool.
- **Coverage** — of the things worth stopping, how many it still stops. This is what you lose if you
  "fix" precision by making the tool watch less.

They pull against each other, and the cheapest way to hit any precision target is to stop watching:
a rule that no longer looks at something can never be wrong about it, and can never catch anything
either. So they are always reported together, from one pass, over the same list.

---

## The order of work, which was the actual control

Three things had to happen in this order, and the order is why the numbers can be trusted.

**First, make the record replayable.** Nothing downstream could be measured until an old incident
could be re-run against new rules.

**Then label, before changing a single rule.** All 92 stored blocks were read and marked *wanted* or
*unwanted*, one line of reasoning each, against a written standard. That standard was committed to
the repository **on its own, before the first label was written** — the history proves it. Then the
labels were frozen with a cryptographic seal.

**Only then tune.** Because if you tune first and label afterwards, you will label in a way that
flatters the tuning, and you will not notice yourself doing it.

**The seal is not decoration.** Precision is a fraction of human judgements, so anyone can hit any
target by re-deciding which blocks were fine after all. This was tested by actually doing it: every
"unwanted" block was flipped to "wanted", which would have shown 100%. The tool refused to print any
number at all, on both surfaces, and said why. The seal also covers the *standard*, because
rewriting the definition of "wanted" moves the number just as effectively and reads like a
clarification rather than a correction.

---

## A correction worth knowing about

The August audit concluded that the record could not be replayed — that 34 of 35 incidents were
lost, because what was stored was a shortened display version of the command, cut off at 200
characters.

**That was wrong, and it was blocking all of this work.** The shortening is real: 62 of the 92
blocks hit that cut. But the *full* command was sitting in a different table the whole time,
complete, with its line breaks intact, up to 20,000 characters long. Every single incident joins to
it exactly. **All 103 are replayable.** The audit measured one column and drew a conclusion about
the record.

The storage was still changed so no future replay depends on that lucky second copy. Nothing was
invented or filled in: recovered incidents are labelled as recovered, and if one ever cannot be
recovered it is reported as unreplayable and counted against the total, never quietly treated as a
pass.

---

## What was actually wrong — the classes, and what each cost

Each was fixed as a *class*, never as an individual incident, and the whole corpus was re-run after
each fix with both numbers recorded together.

| What was going wrong | How many | Still wrong | What it cost in coverage |
|---|---|---|---|
| **Writing about a dangerous command was treated as running one** — an agent writing documentation, a commit message, a test fixture or a policy file whose text mentioned `rm -rf` or `npm publish` | 26 | **0** | none |
| **A quoted phrase read as a command** — `grep -n 'npm publish' NOTES.md` searches *for* the phrase; it does not publish anything | 8 | 1 | none |
| **The agent blocked from its own scratch folder** — a temporary directory its own tooling created for it and told it to use | 4 | 0 | none |
| **Words from two different commands combined into a third** | 1 | **0** | none |
| a file named `ts.env` treated as a credentials file because the name ends in `.env` | 1 | 1 | none |
| an ordinary cleanup inside the project being worked on | 1 | 0 | none |
| a temporary staging folder | 1 | 1 | none |

**Total: 42 unwanted blocks, down to 3.** No coverage was lost at any step.

### The root cause was one thing wearing three hats

The tool was using pattern-matching to guess at shell syntax, and it was guessing wrong in ways the
shell's own published specification settles outright:

- A block of text handed to a program is *data*, and the specification says so explicitly. The tool
  was treating a backtick — the character that makes `code look like this` in ordinary
  documentation — as if it were an instruction to run something. Twelve blocks, every one an agent
  writing prose.
- A file *named* `restore-check.sh` is not a shell. The tool saw `.sh` and assumed it was.
- Text inside quotation marks is text.

So it now does the small amount of real parsing needed to answer one question: *at this point in the
line, is this a command, an argument, quoted text, or a block of data?* Nothing is run, nothing is
evaluated. **And when it does not understand something, it says so and falls back to the old
cautious behaviour** — so anything it cannot read costs an annoyance, never a gap. That was the
condition under which this work had twice been correctly refused before.

### No new dependencies

Three existing libraries were read and rejected, for reasons recorded in full. The count of outside
code this tool depends on to run remains **zero**, which matters because its own security argument
depends on it.

---

## Two real holes found — one of them serious

Both were found by tests written to check something else.

**`sh -c 'rm -rf /'` was not blocked.** Confirmed against the shipped version before anything was
changed. The command was wrapped in quotes, and the check that decides "is this deleting something
outside your project" treated the entire quoted program as if it were a *filename*, resolved it
inside your project, and concluded it was safe. Fixed: a shell is handed programs, not filenames,
and the check now refuses to guess about them at all.

**A rule that was supposed to be absolute was not.** The "never touch credentials" list was being
matched only within the current project, so it protected nothing outside it. This never mattered
while everything outside was blocked anyway — and then a change removed that backstop, and a
credentials file could have slipped through. Found by writing a test to check that a comment in the
code was telling the truth. It was not. It is now.

---

## The scope question: should it only watch the project you are in?

**No, and the data is emphatic.** This was the change the annoyance most obviously pointed at.

| | precision | coverage |
|---|---|---|
| today | 90.9% | 100% (50 of 50) |
| **recommended, and shipped** — the writable area follows whichever project you are in | **94.3%** | **100% (50 of 50)** |
| only watch the current project | 90.3% | **56% (28 of 50)** |

Restricting it to the current project **throws away 22 of the 50 real catches to remove 2
annoyances** — eleven real catches sacrificed per annoyance — and precision does not even improve.
Twenty-one of those 22 are exactly the cross-project catches you named as the most valuable: an
agent working in one repository reaching into another, and every read of your private notes. A guard
that only knows about the folder it was started in cannot notice the agent leaving it.

**But there was a real defect hiding in the same question, and it is fixed.** The tool enforces
across your whole machine, while the *permission* it granted was a single folder — whichever one you
happened to be standing in when you installed it. Every other project you owned was out of bounds
from that moment, including ones that did not exist yet. The only way to say "don't wander" was to
list your other projects as forbidden — a list that is correct the day you write it and wrong the
first day you work in one of them.

The writable area now follows the project you are actually in, every session. That is the change
that takes 90.9% to 94.3%, and it costs nothing. **Your existing settings file is not touched** —
silently rewriting your configuration would be a different problem, not a fix. The 94.3% is what a
fresh install gives.

---

## The dashboard

**Every counter on the old one went up when the tool was wrong.** It showed "59 actions blocked"
during a period when 42 of 92 blocks were mistakes. A reader would conclude 59 useful things had
happened. That reader was you.

It now leads with four things that only rise when the tool is *right*: precision with its
denominator and the date of the labelled set; coverage beside it with its own denominator; what was
caught split by how much it mattered (a caught `rm -rf` above your project is not a caught
`chmod 777`); and what it got wrong grouped by cause, showing **how many fired originally and how
many still fire** — so the number that has to fall is the one on the screen. Activity is still there,
below, under a heading that says what it is: *how often it fired, which is not how often it was
right.*

Rendered and looked at in both light and dark: `dashboard-light.png`, `dashboard-dark.png`.

Three rules are enforced in code rather than promised:

- **Demo and test data can never reach a value figure** — not filtered out at the end, never
  admitted. A test fills a database with 24 manufactured blocks and checks every figure comes back
  *unavailable* rather than flattering.
- **"Unknown" is never shown as a number.** Most people will have no labelled set, so precision for
  them is genuinely unknown — and a page that renders that as 0% or 100% is lying in one direction
  or the other. It says *unavailable*, with the reason.
- **A tampered set is refused, not quietly degraded**, because a made-up precision figure looks
  exactly like a real one in a screenshot.

Your dashboard currently shows **86.5% precision and 64% coverage**, and both are correct: it
reports what *your current settings* do, and your settings file was edited on 29 August in a way
that stopped 18 real catches from firing. That is the dashboard doing its job.

---

## Housekeeping

14 leftover branches and 7 leftover worktrees are gone; **nothing stayed**. Every one was proved
first: no branch name existed on either remote, and every file each branch changed is byte-identical
on the public repository — so the work is preserved on GitHub and deleting the local copy loses
nothing. Two branches differed only because the public repository had moved *past* them; their own
contributions are present, and both were checked line by line. Proof:
`verification/housekeeping-2026-09-08/branch-worktree-proof.txt`. About 176 MB reclaimed.

---

## If the target had been missed

It was not, but the honest number was ready either way. The three remaining annoyances are named
above rather than absorbed into a total, and two of them are deliberately left alone: one is a
command line where the quotation marks are genuinely ambiguous and a shell would also have been
confused, and one needs the tool to track directory changes, which is the kind of guessing that
opens gaps. Fixing either by guessing would trade a real gap for a cosmetic number.

**One thing was tried, measured, and reverted**, and it is the clearest illustration of why coverage
is reported beside precision. Treating the whole system temporary folder as safe removed five
annoyances instead of three — and quietly stopped the tool from catching *writes into a neighbouring
project* and *writes into your home directory*, because the test suite builds its practice
scenarios in that folder. It did not merely miss them; it made the safety tests structurally
incapable of checking. A rule that raises precision by switching off the check is not a precision
fix. It was narrowed, and a test now fails if anyone widens it back.

---

## Verification

- **817 tests pass, 0 fail.** Up from 774; the new ones are the lexer, the replay, the seal and the
  value figures.
- **The safety-test catch rate is unchanged** at 14 of 17, the same as before this run started. The
  three it does not catch are the three it has never been able to catch, and they are named.
- Every claim above was checked by looking: terminal output and rendered screenshots are in
  `verification/precision-2026-09-08/`.
- **Nothing was published, released, posted, purchased or deployed. No hooks were reinstalled.**
  usewarden remains uninstalled on this machine, confirmed by reading all three agent config files
  this run: zero registrations.
- **`./scripts/verify-all.sh` — ALL GATES GREEN, exit 0**, 65 gates, 0 failures, on a clean tree.
- **The publication scans are clean.** One raw-text finding remains in `docs/PRECISION.md`: the
  written standard names one of your private directories as an example. It was **not edited**, and
  that is deliberate — the standard is sealed along with the labels, and editing it after the seal
  is exactly what the seal exists to prevent. It is handled the way the same strings in every other
  document are: the publication step rewrites them, and the rehearsal that scans the rewritten copy
  passes clean. `docs/PRECISION.md` has **exactly one commit in its history** — the standard,
  written before the first label, never touched since.
- **Metered spend this run: $0.00.** Running total $0.0017 of the $15.00 ceiling.

Reproduce the headline figure:

```bash
USEWARDEN_HOME=<directory holding the corpus database> \
  usewarden replay --origin live \
    --labels corpus-labels/blocks-2026-09-08.json \
    --policy corpus-labels/policy-baseline.yaml
```

It refuses to print a number if the seal has been broken.

---

## Decisions recorded

D-277 (the record was always replayable) · D-278 (freezing the labels *and* the standard) ·
D-279 (the shell lexer, and why not a library) · D-280 (`sh -c` was allowed) ·
D-281 (the scope verdict, measured) · D-282 (the temp-folder rule that was reverted).
Confidence 8–10 on each, with the condition that would change it.

## Rollback

Every change is in 9 commits on `main` and nothing was pushed anywhere. `git revert` any one of
them independently, or `git reset --hard 61f0cd2` to return to where this run started. The stored
database was never written to — the corpus was copied and worked on inside the repository, and
`~/.usewarden/` was only ever read.

---

## STILL YOURS

**Nothing.**

No decision was left for you, no technical choice was handed back, and no manual step was created.
The scope question was answered from the labelled data rather than referred to you, which is what
§8 asks for.

Two things are worth knowing, and neither is a task:

1. **Your settings file is 18 real catches worse than it was**, because of the 29 August edit that
   moved one directory out of the forbidden list. Your dashboard now shows this. If you ever
   reinstall, a fresh configuration would restore them — but reinstalling is your call and this run
   did not make it.
2. **The npm package still carries the old engine.** Everything here is in the private repository
   and is not published. Publishing is yours alone and always will be.
