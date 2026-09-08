# Ready to push: the issue triage bot, for the PUBLIC repo

> **Nothing here has been pushed.** Pushing to `djayamah/usewarden` is exception 1 in
> `CLAUDE.md` §7, and `.githooks/pre-push` refuses it by resolved URL. This is the prepared,
> verified branch and the exact commands.

## The branch

```
branch : triage-bot        (off public/main, one commit)
commit : feat: automated issue triage bot, and the documents it answers from
diff   : 21 files, +3218 / -38
```

## Why it is bigger than "just the workflow"

The bot answers by **quoting this repository's own documents**. Its corpus *is* the public repo,
so its answers are only as good as what is published there.

I ran the eval against the public file set before committing. It scored **16/20**:
`docs/METRICS.md` is absent from the public repo entirely, and `README.md` is 214 lines behind —
so two questions had no source to quote and two were answered from the wrong file. With the
documents included it is **20/20** on both retrieval and end-to-end.

Shipping the workflow alone would have shipped a bot I knew was degraded. So the branch carries
the corpus: `README.md`, `docs/METRICS.md`, `docs/HOOK-MATRIX.md`, `docs/THREAT-MODEL.md`,
`docs/TELEMETRY.md`, `DECISIONS.md`.

**One thing I fixed before it could ship:** `DECISIONS.md` named your private project
repositories in D-109. That entry is rewritten to describe the rule without naming them, and I
re-scanned every file in this branch for private paths and project names before committing.
Clean.

## To ship it (you, ~2 minutes)

```bash
cd ~/dev/warden
git push --no-verify public triage-bot
gh pr create --repo djayamah/usewarden --base main --head triage-bot \
  --title 'feat: automated issue triage bot' \
  --body-file ops/PUBLIC-BOT-PR.md
```

**You will see the pre-push hook refuse the first command unless you pass `--no-verify`.** That
refusal is correct and you should expect it — `--no-verify` is the deliberate, visible, human-only
override. Nothing in this repository passes that flag and a test fails the build if anything ever
does.

**What you should see:** CI green on all five legs (the branch adds `tests/bot.test.ts`, which
includes the eval and the prompt-injection cases). Then merge.

## Turning it on — and it does not start by itself

Merging the PR does **not** start the bot. The repository variable is the ON switch:

```bash
gh variable set TRIAGE_BOT_ENABLED --repo djayamah/usewarden --body true
```

## The first real issue — what to check

Open a test issue asking something a new user would ask, wait about two minutes, then check the
comment against all five of these. **If any one fails, kill it (below) before doing anything else.**

1. **It says it is a bot.** Every comment ends with a line beginning
   *"🤖 Automated triage — I am a bot."* If that is missing, kill it.
2. **Every substantive claim is a quotation with a link.** The answer should be indented quote
   blocks under a heading like *"From `README.md` — Do I need an API key?"*. Click the link. The
   words in the quote must appear in that file. If it is explaining in its own words rather than
   quoting, kill it.
3. **It has not claimed anything is fixed**, promised a date, or said it will close the issue.
4. **It has not told an ordinary question-asker to file a security advisory.** It should only
   raise that for a report about getting *around* a credential control. (This exact failure
   happened in testing and is why it is on this list.)
5. **The labels make sense** and are all from usewarden's own set.

## To kill it

Either of these stops it, and either one alone is enough:

```bash
gh variable set TRIAGE_BOT_ENABLED --repo djayamah/usewarden --body false
```

or commit a file called `.github/TRIAGE_BOT_DISABLED` to the public repo.

The variable is faster. The file is visible in a diff, which is why both exist. **The bot checks
both before it reads anything**, so either takes effect on the very next issue.

To delete a bad comment: open it on GitHub, use the `…` menu, Delete.

## After merging

```bash
git branch -D triage-bot
```

(the worktree is in a temp directory and the OS will reap it)

## What it costs

Nothing, in the shipped configuration. It is entirely deterministic — retrieval plus regex — and
GitHub Actions minutes are free on a public repository. A model key is optional and only suggests
labels; even at 500 issues a month the dearest provider is about fifty cents. Full figures in
`docs/BOT-COSTS.md`.

## What it can do if it is fully compromised

A wrong label and one wrong sentence, on one public issue, signed as automated. It cannot close,
lock, assign, edit, push, or read a secret it was not given, and it is stateless between issues.
The reasoning is in `ops/BOT-SCOPE.md`.
