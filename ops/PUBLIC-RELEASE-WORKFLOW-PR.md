# Ready to push: the release workflow the publish plan assumes

> **Not pushed.** Pushing to `djayamah/usewarden` is exception 1. This is the prepared, verified
> branch.

```
branch : release-staged   (ONE commit on top of public/main @ 7429dbd)
commit : c65a40e          release: stage instead of publishing, and meet npm's documented
                          Node floor
diff   : 2 files
```

## Why this exists — read this before starting `ops/PUBLISH-TODAY.md`

**The release workflow on the public repository today is the old one.** It was checked against
GitHub on 2026-08-21, by reading the file the repository actually serves rather than the copy in
this repo:

```bash
gh api "repos/djayamah/usewarden/contents/.github/workflows/release.yml?ref=main" \
  --jq .content | base64 -d | grep -nE "npm (stage|publish)|node-version"
```

which returns:

```
53:          node-version: '22.13.0'
81:        run: npm publish --provenance --access public
```

Two problems, and both of them break the plan in `ops/PUBLISH-TODAY.md`:

| What is live | Why it matters |
|---|---|
| `npm publish` — a **direct release** | The plan's whole security argument is that the workflow can only *stage*, and that the final authorisation lives on your npm account behind your security key rather than inside GitHub. This workflow releases. |
| `node-version: '22.13.0'` | npm documents **22.14.0** as the floor for trusted publishing. One patch below it. This is the pin the last run fixed — **in this repository, which is not where the release runs.** |

There is also a third, quieter problem: **steps 8 and 9 of the runbook describe a workflow that
does not exist yet.** They tell you to go to Actions → release → Run workflow and choose a mode of
`dry-run` or `stage`. The workflow currently on the public repository has no mode input at all, so
there is nothing to choose. That is not a mistake in the runbook — step 7 is what puts the new file
there — but nothing warned you that the thing you are about to operate is not the thing described.

**If you configure the trusted publisher in step 6 (`--allow-stage-publish` only) and then run the
workflow that is live today, the registry will refuse it.** That refusal is the control working
exactly as designed, and it would be very confusing without this page.

## What is in the branch

| File | Change |
|---|---|
| `.github/workflows/release.yml` | `npm stage publish` instead of `npm publish`; a `dry-run` / `stage` mode input; Node pinned to `22.14.0` |
| `.npmrc` | npm 11.15.0's install-time source controls — `allow-file`, `allow-remote`, `allow-git` set to `none` |

`allow-directory` is deliberately **left at its default**. Setting it to `none` breaks `npm pack`,
which is how the package is built — packing a working directory is itself a "directory" fetch, so
the control that forbids directory dependencies also forbids building the release. Measured one
control at a time on npm 11.19.0 and documented inside `.npmrc` itself.

## Verified

```
SCAN_REF="public/main..release-staged" ./scripts/pre-public-scan.sh   SCAN CLEAN
SCAN_REF=release-staged SCAN_SCOPE=tree ...  --classes=identity        CLEAN
commit metadata (PASS 3)                                               CLEAN, 0 of 1
./scripts/verify-hardening.sh  "release is STAGED, not published"       PASS
./scripts/verify-hardening.sh  "CI Node meets the publishing floor"     PASS (22.14.0 >= 22.14.0)
```

Those last two rows are checking **this repository's** copy of the workflow, which is the copy in
this branch. They will keep saying PASS whether or not the branch is ever pushed — that is the
whole reason this page exists, and the reason the check against the live GitHub file is written out
in full at the top.

## To ship it

```bash
cd ~/dev/warden

# 1. Still current with the public HEAD? If this prints anything, rebuild before pushing.
git fetch public main
git log --oneline release-staged..public/main

# 2. The commit that was verified.
git rev-parse release-staged        # expect c65a40e5c72cae7c43c51cebbd1c63ae444319b5

# 3. Push and open the PR.
git push --no-verify public release-staged
gh pr create --repo djayamah/usewarden --base main --head release-staged \
  --title 'release: stage instead of publishing, and meet npm'"'"'s documented Node floor' \
  --body-file ops/PUBLIC-RELEASE-WORKFLOW-PR.md
```

`--no-verify` is needed because `.githooks/pre-push` refuses any push whose resolved URL is the
public repository. That guard exists to stop *me* pushing there and cannot tell you from me.

**After merging, confirm the right file actually landed** — do not assume the merge did what the
diff said:

```bash
gh api "repos/djayamah/usewarden/contents/.github/workflows/release.yml?ref=main" \
  --jq .content | base64 -d | grep -nE "npm (stage|publish)|node-version"
```

You want to see `npm stage publish` and `22.14.0`. Only then do steps 8 and 9 of
`ops/PUBLISH-TODAY.md` describe the workflow you are actually running.

## Order of operations

This branch and `ops/PUBLIC-BOT-FIX-PR.md`'s branch are independent — different files, no overlap.
Either can go first. **Both should be merged before step 7 of the publish runbook**, because step 7
is "get the release commit onto `main`", and the commit provenance will point at is whatever `main`
is at that moment.
