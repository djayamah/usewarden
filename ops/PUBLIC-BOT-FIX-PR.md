# Ready to push: the triage-bot fix

> **Superseded and extended.** The first fix (per-sentence retrieval, evidence floor, conditional
> disclosure) addressed one INSTANCE. The bot then failed the same way again on a different
> instance, and the second round below fixes the CLASS. Both are in the branch.

> **Not pushed.** Pushing to `djayamah/usewarden` is exception 1. This is the prepared, verified
> branch.

```
branch : triage-bot-fix     (rebuilt 2026-08-21 on public/main @ 7429dbd, ONE commit)
commit : 4e7755f            fix(bot): answer questions, classify intent, and stop failing
                            on real phrasing
diff   : 13 files, +1930 / -83
```

## Why there is a fix at all

I turned the bot on, opened [issue #9](https://github.com/djayamah/usewarden/issues/9) phrased the
way a confused new user actually writes, and **it failed its own checklist.** It declined to
answer, asked someone who had not installed usewarden to run `usewarden status --json`, and then
claimed in its disclosure that *"everything substantive above is a direct quotation"* while having
quoted nothing.

The bot is **disabled** (`TRIAGE_BOT_ENABLED=false`) and #9 carries a note explaining what
happened, left open as the record.

## What was wrong, and why the eval never caught it

| Defect | Cause |
|---|---|
| Declined a question the README answers on its front page | Coverage scored the **whole body** as one query. Two real questions wrapped in "hi, saw this on github" and "sorry if this is obvious" diluted it to **0.19**. The single sentence *"does it need one of those api keys to work?"* scores **0.40**. |
| Claimed a quotation it had not made | The disclosure was a fixed string |
| Led with a maintainer's decision log | `DECISIONS.md` is long and term-rich, so BM25 preferred it |
| Quoted the wrong paragraph of the right section | The excerpt picked most-shared-words, which in a long section is usually a closing detail |

**Every eval question is one clean sentence.** The eval set was structurally incapable of finding
any of this, and it stayed at 20/20 through every one of these defects. Real issues ramble,
apologise, and ask more than one thing.

## The fix

- **Retrieve per sentence**, merging by best score per chunk.
- **An evidence floor** beside the coverage fraction — a three-word sub-query matching two words
  scores 0.67 on almost no evidence. The floor is 2, chosen by measurement: at 3 the eval drops to
  18/20 because an honest short question has only three distinctive terms.
- **Maintainer docs outranked** when the query is a question.
- **Question-headed sections boosted** when the query is a question.
- **Excerpts biased toward the section opening**, and horizontal rules stripped.
- **The disclosure is conditional** and says plainly when it has quoted nothing and guessed
  at nothing.

Five regression tests use the real issue text verbatim. Verified against the **public** file set:
eval 20/20 retrieval, 20/20 end-to-end.

## What it now produces for that same issue

> **Thanks for asking — here is the answer from the documentation.**
>
> **From `README.md` — *Do I need an API key?*:**
> > No. **Layer 1 — the blocking — needs no key and costs nothing.** […] Layer 2, the semantic
> > drift judge, is optional and **you bring your own key** […]
>
> **From `README.md` — *Telemetry*:**
> > Off by default. v1 ships **no endpoint at all** […] nothing leaves the machine.

Both questions answered, both from files that exist, both linked.

## To ship it

```bash
cd ~/dev/warden

# 1. Confirm the branch is still current with the public HEAD. If this prints anything, the
#    public repo moved after the branch was built and it must be rebuilt before pushing.
git fetch public main
git log --oneline triage-bot-fix..public/main

# 2. Confirm the commit is the one that was verified.
git rev-parse triage-bot-fix        # expect 4e7755f9842c69a21ff87c5b621bae2e689a8ee2

# 3. Push and open the PR.
git push --no-verify public triage-bot-fix
gh pr create --repo djayamah/usewarden --base main --head triage-bot-fix \
  --title 'fix: the triage bot declined real questions, and the eval could not see it' \
  --body-file ops/PUBLIC-BOT-FIX-PR.md
```

**Why `--no-verify` is needed, and what it is bypassing.** `.githooks/pre-push` refuses any push
whose resolved URL is the public repository. That guard exists to stop *me* pushing there — it is
permanent exception 1 in `CLAUDE.md` §7 — and it has no way to distinguish you from me, so it
refuses your push too. `--no-verify` skips it for this one command. It skips nothing else: the
branch has already been scanned, built, and tested below, and none of that was done by the hook.

After merging:

```bash
gh variable set TRIAGE_BOT_ENABLED --repo djayamah/usewarden --body true
```

Then open a new test issue and check it against the five points in `ops/PUBLIC-BOT-PR.md`.

## To kill it again

```bash
gh variable set TRIAGE_BOT_ENABLED --repo djayamah/usewarden --body false
```

## One limitation, stated

Retrieval is lexical. It cannot bridge *"does it upload my project"* to *"does this send my
code"* — different words, same question — so it answered that half from the Telemetry section
rather than the FAQ entry written for it. The answer is correct and cited; it is simply not the
passage a human would have picked. Fixing that properly needs embeddings, which would mean a
dependency and a model call on every issue. Not worth it yet, and recorded here rather than
discovered later.


---

# Round two: the class, not the instance

The first fix made the bot answer that issue correctly. It did not stop the bot assuming every
issue is a defect report, so the next beginner question produced the same shape of failure:
`Thanks for the report`, an `unmatched` label, a demand for `usewarden status --json` from someone
who had installed nothing, and a warning about pasting API keys.

The credential warning was a **footer on every comment the bot ever wrote**. That is the whole
defect in one line: boilerplate that goes out regardless of what was asked is boilerplate nobody
chose to send.

## What changed

**Intent is classified FIRST** (`bots/triage/src/intent.ts`) — question / bug / feature /
security — and everything else is downstream of it. The rule is not grammar:

> A bug report claims the tool is **wrong**. A question asks what the tool **does**.

"any chance of windows support" is grammatically a question and is a feature request. "why did it
stop my agent" has no question mark and is a question. Unrecognised input is classified as a
question, never a bug, because the two mistakes cost wildly different amounts.

- **A question** gets the answer, quoted and cited, and nothing else. No diagnostics, no
  credential warning, no "thanks for the report".
- **A bug report** gets the triage template. That path is unchanged.
- **A feature request** gets an acknowledgement and an `enhancement` label, and no quotation at
  all — the corpus documents what usewarden does, not what it will do.
- **A security report** still routes to security. Narrowing the route so beginners are not alarmed
  must not stop a real bypass report reaching it, and a test asserts it does not.

## The honest numbers

Scored on a set built out of the phrasing that broke it — lowercase, unpunctuated, non-technical,
plus long rambling bodies whose real question is one clause in the middle:

| | original eval | beginner eval |
|---|---|---|
| before | 20/20 retrieval, 20/20 end-to-end | **4/12** |
| after | 20/20 retrieval, 20/20 end-to-end | **12/12** |

The original eval reported 20/20 throughout, including while the bot was posting failures in
public. Its questions are all one clean sentence in the project's own vocabulary; real issues are
none of those things. The before number is reproducible from commit `2840db1`:

```bash
node dist/bots/triage/src/score-beginner.js --current
```

The beginner set contains bug reports and a feature request as well as questions, because a set of
only questions scores 12/12 for a bot that answers everything and triages nothing.

## Four retrieval defects only beginner phrasing could find

1. **Maintainer-doc down-weighting keyed off a literal `?`.** Beginner questions often have none,
   so DECISIONS.md was never down-weighted for them — and the bot answered a pricing question by
   quoting the maintainer's log of its own previous failure. Intent is passed in now.
2. **The two-matched-terms floor is impossible for a three-word question.** "is this free" has one
   content term, so every short question declined by construction. The floor is capped at what the
   question contains.
3. **Global top-N undid per-sentence retrieval.** Two strong passages about cost took both slots
   and the privacy half of the same issue went unanswered. Slots are filled round-robin across
   sub-queries, strongest first, and a question gets three quotations.
4. **The README never contained the word "free".** A documentation gap the eval found; fixed with
   an FAQ entry rather than a cleverer retriever.

Measured and **rejected**: an IDF-weighted evidence floor. It looked principled and made both eval
sets worse at every value tried, so it was removed rather than shipped as a knob set to zero.

## One guard defect, which failed closed

The forbidden-phrase guard refused to post a correct answer because a cited filename —
`verification/live/12-dotenv-bypass-fixed.txt` — contains the word "fixed". A citation header is
derived entirely from the source, like the quoted lines already excluded. This failure is worse
than a wrong finding because it fails silently: the bot posts nothing and looks broken. A test
A/B-proves the guard still catches a sentence the bot actually wrote.

## State

**`TRIAGE_BOT_ENABLED=false`.** It stays off until this ships and a real issue comes back clean.
469 tests pass; the beginner eval is gated in the suite, so a regression fails the build.


---

## Branch state (rebuilt and verified 2026-08-21, NOT pushed)

```
branch : triage-bot-fix   (ONE commit on top of public/main @ 7429dbd)
commit : 4e7755f          fix(bot): answer questions, classify intent, and stop failing on
                          real phrasing
diff   : 13 files, +1930 / -83
```

The previous version of this branch sat on `58173e6` and was **stale in two ways**: the public
repo had moved on by one commit (the identity-string fix, #10), and four of the bot files had
moved on privately since the branch was cut. It has been rebuilt from scratch on the current
public HEAD, carrying the current private versions of every bot source and test.

### What is in it, and what is deliberately not

| In | Why |
|---|---|
| `bots/triage/src/` — `intent.ts`, `answer.ts`, `corpus.ts`, `eval.ts`, `triage.ts` | the fix |
| `bots/triage/src/beginner-eval.ts`, `score-beginner.ts` | the eval set that found round two |
| `bots/triage/src/adversarial-eval.ts`, `score-adversarial.ts` | the eval set that found round three |
| `tests/bot.test.ts`, `bot-beginner.test.ts`, `bot-adversarial.test.ts` | 63 tests, gated in the suite |
| `README.md` — the *Is it free?* FAQ entry | a documentation gap the beginner eval found |
| `README.md` — the test count | it said 427; see below |

| Out | Why |
|---|---|
| `bots/x/` | a different bot, and posting anywhere is permanent exception 3 |
| the CI workflow changes on private `main` | a separate concern from the bot; own PR |
| everything else on private `main` | not part of this fix |

### Verified ON THE PUBLIC TREE, not the private one

Built in a worktree reset to `public/main`, so the corpus is the smaller published file set and
the answers it quotes are answers a public reader can actually follow.

```
npm run build                                   clean
npm test                                        310/310
node --test dist/tests/bot.test.js               38/38
node --test dist/tests/bot-beginner.test.js      13/13
node --test dist/tests/bot-adversarial.test.js   12/12
node dist/bots/triage/src/score-beginner.js      12/12 overall, 12/12 intent
node dist/bots/triage/src/score-adversarial.js   23/23 overall, 0 threw
original eval (runEval / runEndToEnd)            20/20 retrieval, 20/20 end-to-end
```

Reproduce all of it:

```bash
cd ~/dev/warden
git worktree add --detach .worktrees/botfix triage-bot-fix
cd .worktrees/botfix && npm run build && npm test
node dist/bots/triage/src/score-beginner.js
node dist/bots/triage/src/score-adversarial.js
```

### One defect found while rebuilding, and fixed in this branch

**The published README claimed 427 tests. The published tree runs 310.**

`verify-all.sh` has a gate that pins the README's test count to the suite's real count — and it
passes, because it checks the *private* README against the *private* suite. The public README is a
different file, shipping a different subset, and nothing anywhere was checking it. The number had
been wrong on the public front page since publication.

This is the same shape as D-140 and D-142: a control aimed at what we are about to ship, with
nothing aimed at what we already shipped. Corrected here to the measured number. Note that the
count is a property of the *public* tree, so it has to be measured in a worktree reset to
`public/main` — copying the private number over is what would put it wrong again.

### The three scans, and why one of them says BLOCKED

```bash
SCAN_REF=triage-bot-fix SCAN_SCOPE=tree ./scripts/pre-public-scan.sh --classes=identity
SCAN_REF="public/main..triage-bot-fix" ./scripts/pre-public-scan.sh
SCAN_REF=triage-bot-fix ./scripts/pre-public-scan.sh
```

| Scan | Question it answers | Result |
|---|---|---|
| tree of the branch | what would this branch **publish**? | **CLEAN** — 133 files, 0 findings |
| `public/main..triage-bot-fix` | what does this branch **add** to public history? | **CLEAN** — 1 commit, 13 blobs, 0 findings |
| whole history of the branch | what is in the history it **sits on**? | **BLOCKED — 1 finding** |

**The third one blocking is expected and is not about this branch.** The finding is blob
`92b9d69e` in `ops/BOT-SCOPE.md`, reachable from commit `58173e6` — a commit that has been on the
public repository since PR #8 and is the parent of the fix you already merged as #10. The branch
inherits that history; it does not add to it. The first two scans are the ones that say anything
about this branch, and both are clean.

If the third scan ever reports **more than one** finding, or names a blob that is not `92b9d69e`,
stop: that is a real regression and this table is no longer the explanation.

### State

**`TRIAGE_BOT_ENABLED=false`.** It stays off until this ships and a real issue comes back clean.

**Not pushed. Pushing to `djayamah/usewarden` is exception 1.** The commands under *To ship it*
are exactly what would ship it, and nothing above ran them.
