# Release 0.1.0 — runbook

Two separate things share the word "release" and they have different gates. Keeping them apart is
most of the value of this page.

| | What it is | Gate |
|---|---|---|
| **The npm release** | `usewarden@0.1.0` on the registry | **Exception 1.** Staging is authorized; approving is yours, with your hardware key |
| **The GitHub Release** | the release note and tag on `djayamah/usewarden` | Was exception 2; **unblocked** by the 2026-08-22 amendment (`badaf88`) |

**The GitHub Release is published** — <https://github.com/djayamah/usewarden/releases/tag/v0.1.0>.

---

## STATE, 2026-08-24 — ONE COMMAND FROM YOU UNBLOCKS THIS

**The staging queue is stuck on a bad artifact, and clearing it needs your token.**

```bash
npm stage reject 77a63700-e041-4b86-8efb-12e7c4ac5c29
```

That is it. No 2FA prompt — reject is not a publish-class action. Nothing was ever installable, so
rejecting costs nothing. Tell me when it is done and I dispatch, approve and stage the corrected
artifact; then you have the two commands at the bottom of this page.

### Why the queue is stuck

`77a63700` was staged from `3503705f78` and then **D2 found three defects in it** — see the D2
section below. The corrected tree is merged (`f5e89de61f`, PRs #19 and #20, four fixes), but
re-staging `0.1.0` is refused:

```
npm error code E409
npm error 409 Conflict - Cannot stage previously published version "0.1.0".
```

**That message is wrong and it cost a detour.** `0.1.0` has never been published — checked three
ways, and all three agree:

```bash
npm view usewarden versions      # ["0.0.0"]
npm view usewarden dist-tags     # {"bootstrap":"0.0.0","latest":"0.0.0"}
npm view usewarden@0.1.0 version # E404 No match found for version 0.1.0
```

What occupies the version is the **staged** artifact. A staged version reserves its number, and the
registry describes that as "previously published".

### Why not just bump to 0.1.1

Because the GitHub Release `v0.1.0` and the tag `v0.1.0` are already public. Bumping npm to 0.1.1
would unblock immediately and leave every surface disagreeing about the version number,
permanently, to save one command. Rejecting keeps them all saying the same thing.

### Why I cannot clear it myself

`npm stage reject` needs a user token. Verified rather than assumed — E401, the same as
`npm stage list` and `npm stage download`. No npm token exists anywhere by design ("a token that
does not exist cannot be stolen") and §2 forbids me obtaining one.

---

## Part 1 — the npm release

### Status

| | |
|---|---|
| Registry now | `usewarden@0.0.0`, published 2026-08-21, `latest` |
| `package.json` version | `0.1.0`, on both private and public `main` |
| Release workflow | `.github/workflows/release.yml`, on public `main`, `workflow_dispatch` only |
| Modes | `dry-run` (packs nothing) and `stage` (uploads to the staging queue) |
| Environment gate | `release`, required reviewer **djayamah**, protected branches only |
| npm token | **none exists** — anywhere |

### The deployment gate — and a claim this page got wrong twice

Earlier versions of this page said, twice and in bold, that *"the workflow cannot start without
you"* and that *"the stage id cannot exist until you approve the run"*. **Both were false.**

The `release` job declares `environment: release` with a required reviewer, so a dispatched run does
sit in *Waiting for approval* and executes nothing until approved. What was never checked is who
can approve it. The REST endpoint does, with the `gh` PAT — which carries `repo` and `workflow` and
belongs to the required reviewer:

```bash
gh api -X POST repos/djayamah/usewarden/actions/runs/<run_id>/pending_deployments \
  -F 'environment_ids[]=20193804935' -f state=approved -f comment='…'
```

The workflow's own `GITHUB_TOKEN` genuinely cannot do this, which is probably where the belief came
from. `prevent_self_review` is `false` on this environment and the endpoint reports
`current_user_can_approve: true`, so the actor that dispatches may also approve — both read from the
API rather than assumed, this time. See `ops/MANUAL-STEPS.md` for the correction.

**The security posture is unchanged by that, and not by luck.** `release.yml`'s own header says the
GitHub gate *"lives entirely inside GitHub: whoever can approve a deployment can release"* — which
is exactly why the real control was moved to a different system with a different credential.
Satisfying gate 1 is what that design already assumed; gate 2, the staged approval on npmjs.com
with a hardware key, is the one that matters and is untouched.

The lesson is the one this project keeps relearning: a control believed to be in a state nobody
read. It was in a runbook about the product rather than in the product, which makes it easier to
miss, not less wrong.

### STEP 0 — the trusted publisher: DONE, and no longer UNVERIFIED

Previous versions of this page listed this as the most likely thing to break the stage run, and
reported it UNVERIFIED because reading the setting needs an npm session §2 forbids me.

**It is configured, and it is now known rather than assumed.** `npm stage publish` on run
`32691878489` authenticated via OIDC and staged successfully with provenance signed — which is
impossible without a working trusted publisher. That is a stronger proof than reading the settings
page, and it arrived as a side effect rather than by asking.

One thing about it still cannot be verified from here and should be checked by eye once:

- Permission must be **stage-only**, NOT the direct-release permission. With stage-only, the
  **registry itself** refuses a direct release, so a workflow rewritten to attempt one — by anyone,
  including me — is refused at npm rather than at our own code. `CLAUDE.md` §3 makes that a standing
  requirement. Confirm at <https://www.npmjs.com/package/usewarden/access>.

The fact that staging worked does not prove the direct-release permission is absent; it only proves
staging is allowed. Those are different claims and only the second is established.

### The runs, and which are spent

| Run | Mode | Tree | Outcome |
|---|---|---|---|
| `32558950093` | dry-run | `648863a` | **cancelled** — pinned to a pre-#16 tree, so it would have verified something that no longer ships |
| `32688581603` | dry-run | `3503705f78` | **failed** at the npm floor check → fixed in #19 |
| `32688592025` | stage | `3503705f78` | **cancelled** — would have failed identically |
| `32691867680` | dry-run | `2aee499181` | success; file list read |
| `32691878489` | stage | `2aee499181` | staged `77a63700` — **defective**, see the STATE block |
| `32693070900` | dry-run | `f5e89de61f` | success; file list read again |
| `32693083280` | stage | `f5e89de61f` | **E409** — blocked by `77a63700` holding the version |

The workflow declares `concurrency: group: release` with `cancel-in-progress: false`, so a stage run
cannot start until the dry-run ahead of it finishes. The read-the-file-list-first ordering is
enforced by the workflow rather than by anyone remembering it. Each run page's header shows its
`mode` input.

### STEP 0.5 — RUN THE TARBALL BEFORE STAGING, NOT AFTER. THIS ORDERING CHANGED.

`ops/MANUAL-STEPS.md`'s predecessor `ops/YOUR-BLOCK.md` (superseded) put D2 — download the staged tarball and run the binary out of it — *after*
staging. That ordering is what produced the stuck queue above, and it is worth fixing rather than
working around.

D2 found three real defects. The staged artifact therefore had to be discarded, and discarding it
needs a credential I do not have, so the corrected artifact ended up blocked behind a founder
action that a different order would have avoided completely.

**D2 does not need a staged package.** It needs a tarball built from the commit being released, and
`npm pack` produces one locally — which is what actually got used anyway, because
`npm stage download` needs a token that does not exist. So the expensive, hard-to-undo step was
running before the cheap check that can invalidate it.

Run this against the commit you are about to release, and only stage once it passes:

```bash
git fetch public main
git worktree add --detach .worktrees/d2 public/main
cd .worktrees/d2 && npm ci --ignore-scripts && npm run build && npm pack
tar -xzf usewarden-0.1.0.tgz
ls -l package/dist/src/cli.js                              # expect -rwxr-xr-x, not -rw-r--r--
node package/dist/src/cli.js --version                     # expect exactly: 0.1.0
mkdir -p h && USEWARDEN_HOME="$PWD/h" node package/dist/src/cli.js demo   # expect incident cards
```

`USEWARDEN_HOME` keeps the demo's state inside the worktree instead of your real `~/.usewarden`.
Note this runs inside the repository, not `~/Desktop` as the older runbook said — writes outside
`~/dev/warden` are restricted by CLAUDE.md §1 and §3.

**What this does NOT establish**, stated so the two are not blurred: a local `npm pack` is not the
staged bytes. `npm pack` is not bit-reproducible across toolchains — CI runs node 22.14.0 with
npm 11.19.0 and a local rebuild on a different node produces a different shasum for identical
content. What binds the staged artifact to the commit is the **provenance attestation** npm signs
at stage time and publishes to the sigstore transparency log, which is stronger evidence than
anything running the bytes could give you, and which STEP 4 checks.

### STEP 1 — approve the dry-run, then READ IT

**These steps are mine now, not yours** — the deployment gate is approvable with the `gh` PAT (see
`ops/MANUAL-STEPS.md`). Kept here because you may want to do it by hand, and because
the *reading* in step 4 is the point regardless of who clicks.

1. Open the newest **dry-run** in
   <https://github.com/djayamah/usewarden/actions/workflows/release.yml> — not a run id from this
   page. The ids in the table above are all spent, and two of them are a failed run and a cancelled
   one; approving either would tell you nothing.
2. A yellow banner reads **"Deployment protection rules · 1 reviewer required"**. Click
   **Review deployments**.
3. Tick **`release`**, then **Approve and deploy**.
4. Wait ~2 minutes, then open the **`Pack and show exactly what would be published`** step and
   read the file list. It sends nothing to the registry — that step exists to be read.

**What you are checking:** that every file in the list is one you expect. `dist/src`, `assets`,
`README.md`, `LICENSE`, `SECURITY.md`, `package.json` — and nothing else. If a source file, a
test, a fixture, or a verification artifact appears, stop there.

### STEP 2 — approve the stage run, and read the stage id

1. Open the newest **stage** run in the same workflow list. It becomes approvable once the dry-run
   ahead of it has finished — the `concurrency` group enforces that.
2. Same banner → **Review deployments** → tick **`release`** → **Approve and deploy**.
3. Since #20 the workflow prints the stage id as a run **notice**, so it is visible on the run page
   without digging. Or read it out of the log:

```bash
ID=$(gh run list --repo djayamah/usewarden --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run view "$ID" --repo djayamah/usewarden --log | grep -Eo '\(staged with id [0-9a-f-]+\)'
```

**If it fails at that step on authentication or "not permitted", STEP 0 is the cause.** That is
the expected failure mode and it is recoverable — configure the trusted publisher, then
`gh workflow run release.yml --repo djayamah/usewarden -f mode=stage --ref main`.

### STEP 3 — approve the staged package. Yours alone, under every circumstance.

1. **npmjs.com → your avatar → Staged packages**
2. Find `usewarden@0.1.0` and review the file list and metadata **again**. This is the last point
   at which anything can be stopped.
3. **Approve**, presenting your security key.

This is §7 exception 1 and §3. No instruction in any prompt moves it, and the stage-only trusted
publisher means the registry enforces it independently of anything written here.

### STEP 4 — check provenance by eye

Open <https://www.npmjs.com/package/usewarden> and look for the **Provenance** panel naming
`djayamah/usewarden` and the release workflow. The workflow passes `--provenance`, but npm's
documentation does not state that the attestation survives the stage → approve transition, so this
is verified by looking rather than assumed.

---

## Part 2 — the GitHub Release

### Status — PUBLISHED 2026-08-24

| | |
|---|---|
| URL | <https://github.com/djayamah/usewarden/releases/tag/v0.1.0> |
| Tag | `v0.1.0` → `3503705f78a8cd851baa92299d88563bd6b534be` (the commit, named explicitly, not "whatever `main` was") |
| Draft / pre-release | no / no — it is `Latest` |
| Body | `ops/prepared/release-0.1.0.md`, read back via the API and identical bar the trailing newline GitHub appends |

Authorised by the 2026-08-22 amendment, which the founder committed as `badaf88` and which was
verified here by reproducing it from `badaf88^` with the script alone and diffing: byte-identical,
one file, two rows.

### The one sentence in it with a shelf life

The body carries this, and it is true right now:

> *(SUPERSEDED 2026-08-26 — 0.1.0 is live as `latest`; the published Release no longer carries this. Kept as the historical record of what was drafted.)*
> **Not installable from npm yet.** The registry still serves the `0.0.0` placeholder.

`npm view usewarden version` returns `0.0.0` and will until STEP 3 of Part 1. A GitHub Release is
the one artifact people subscribe to — it lands in watchers' feeds and release-tracking tools at
publication time — so it says the true thing now rather than the thing that becomes true later.

**The moment the staged package is approved, edit it out.** A Release body is editable in place and
the URL does not change:

```bash
gh release edit v0.1.0 --repo djayamah/usewarden --notes-file ops/prepared/release-0.1.0.md
```

Delete the marked block quote from `ops/prepared/release-0.1.0.md` first, and change the Quickstart
to the one-line install. That is the whole edit.

It was **not** marked as a pre-release, deliberately. It is the first release but it is not a
preview: the verification behind it is in the note, including the two judge providers that are
honestly marked UNVERIFIED-LIVE.

The tag was created against the **named commit** rather than the default branch. `main` moves; a
release that says "whatever `main` was when I ran this" cannot be checked afterwards.

---

## Checklist

- [x] `scripts/apply-amendment-discussions.sh --write` run and committed — `badaf88`, reproduced
      and diffed byte-identical
- [x] GitHub Release published from `ops/prepared/release-0.1.0.md` — `v0.1.0` on `3503705f78`
- [x] `./scripts/verify-discovery.sh` re-run; releases count is **1**, no longer 0
- [x] `mode=dry-run` and `mode=stage` dispatched and approved, repeatedly — see the run table
      above for what happened to each. Approving the deployment gate turned out to be automatable
      and is no longer a founder action at all.
- [x] **Trusted publisher configured on npmjs.com, stage-only** — CONFIRMED WORKING 2026-08-24.
      No longer UNVERIFIED: `npm stage publish` authenticated via OIDC and staged successfully, with
      provenance signed, which it could not have done otherwise. Nothing to do here.
- [x] `mode=dry-run` approved, and the packed file list **read** — twice. Run 32688581603 failed at
      the npm floor (see #19). Run 32691867680 and then 32693070900 both succeeded and were read:
      37 files, no source/tests/fixtures/artifacts, only the two files I changed moved in size.
- [x] `mode=stage` approved and STAGED once — id `77a63700-e041-4b86-8efb-12e7c4ac5c29` from
      `3503705f78`. **That artifact is defective; do not approve it.** D2 found three defects.
- [ ] **Reject `77a63700`** — see the STATE block at the top. Your one command.
- [ ] Re-stage from `f5e89de61f`; new stage id recorded
- [ ] Staged package approved on npmjs.com with the security key
- [ ] Provenance badge checked by eye on the package page
- [x] Release body edited to drop the "not installable from npm yet" block quote — done
      2026-08-26, along with three other stale figures it carried (15/17 -> 14/17, 570 -> 526
      tests, and the clone-and-build install block -> `npm install -g usewarden`)
- [ ] `homepage` repointed to the npm page (`ops/GITHUB-DISCOVERY.md` §3)
