# MERGED — the SECURITY.md disclosure fix for the PUBLIC repo

> **Status: DONE.** The founder pushed and merged this as
> [djayamah/usewarden#7](https://github.com/djayamah/usewarden/pull/7) on 2026-08-20. The public
> `main` now links the advisory form and contains no placeholder, confirmed by reading
> `public/main:SECURITY.md`. GitHub auto-deleted the branch on merge.
>
> Nothing in this repository pushed it. `.githooks/pre-push` still refuses the public remote by
> resolved URL — re-verified after the merge. This document is kept as the record of what was
> prepared and why.

## What it fixes

`SECURITY.md` named GitHub private vulnerability reporting as the preferred disclosure route
**while that feature was disabled on the repository**, and the stated fallback was the literal
string `SECURITY_CONTACT_PLACEHOLDER`. A reporter following the document found no button and no
address. The project had no working security contact at all.

## What has already been done (no push required, and it is live now)

These are repository *settings*, not content, and `scripts/apply-hardening.sh` already governs
them. Applied and verified 2026-08-20:

| Control | Before | After |
|---|---|---|
| Private vulnerability reporting | **disabled** | **enabled** |
| Secret scanning | disabled | **enabled** |
| Secret scanning push protection | disabled | **enabled** |

`./scripts/verify-hardening.sh` now checks all three, plus that `SECURITY.md` links a real
advisory form and publishes no email address, so none of it can silently revert.

## The branch

Already built locally, off `public/main`, one commit, one file:

```
branch : security-contact
commit : security: name a disclosure channel that actually exists
diff   : SECURITY.md | 14 insertions(+), 12 deletions(-)
```

## Why there is no email address

The instruction that queued this work said to set the address to `<PUT YOUR ADDRESS HERE>`,
which is a template marker rather than an address — and the same instruction required that no
placeholder remain anywhere in the repository. Both cannot be true at once.

Rather than invent an address or publish a personal one, the file now uses a route that needs no
address at all. That is the better answer on the merits, not a workaround:

- a personal address in a public `SECURITY.md` **cannot be rotated and cannot be un-published**;
- a stale or invented address **bounces**, which converts a responsible reporter into a public
  issue — the exact outcome the policy exists to prevent;
- the advisory form works without the reporter knowing anyone's address, cannot land in spam, and
  produces the advisory record automatically.

**If you do want a published address**, it is a one-line addition and it should be a role alias
you control (`security@<yourdomain>`), never a personal mailbox. Add it under the advisory link
and re-run `npm test` — `tests/packaging.test.ts` asserts the file publishes no email address, so
that test is the one to update at the same time, deliberately.

## To ship it (you, ~30 seconds)

```bash
cd ~/dev/warden
git push public security-contact          # pre-push hook allows this branch name? NO — see below
gh pr create --repo djayamah/usewarden --base main --head security-contact \
  --title 'security: name a disclosure channel that actually exists' \
  --body-file ops/PUBLIC-SECURITY-PR.md
```

**The pre-push hook will refuse that first command**, by design — it matches on the resolved URL
of the public repository, not on the branch. That refusal is correct and you should see it. To
override it deliberately, as the founder:

```bash
git push --no-verify public security-contact
```

`--no-verify` is the deliberate, visible, human-only escape. Nothing in this repository passes it
and a test fails the build if anything ever does.

## After merging

Delete the local branch and worktree:

```bash
git worktree remove "$(git worktree list --porcelain | grep -A1 security-contact | head -1 | cut -d' ' -f2)" 2>/dev/null
git branch -D security-contact
```
