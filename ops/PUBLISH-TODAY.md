# PUBLISH — the actual steps, in order

**Nothing in this document has been executed.** No package exists on npm, no npm token exists, no
trusted publisher is configured, and no release workflow has ever been run. Every step marked
**[YOU]** is yours to do. Every step marked **[AUTOMATED]** is a thing that runs by itself once
you have started it.

Written 2026-08-20 against npm's current documentation. Every claim below has a source, and where
a claim comes from a blog post rather than from npm itself, it says so.

**Revised 2026-08-21 after a full dry run.** Everything in this document that could be rehearsed
without touching the registry was rehearsed, and six things were wrong. They are fixed in place,
and each correction says what it used to say so you can tell whether you had already read the
wrong version.

| Rehearsed | Result |
|---|---|
| `release.yml` Node pin is 22.14.0, npm's documented floor | correct — the 22.13.0 problem is fixed |
| `release.yml` stages and cannot release | correct — `npm stage publish`, no direct-release command |
| Trusted-publisher command grants stage only | correct — `--allow-stage-publish` present, `--allow-publish` absent, and the syntax matches `npm trust --help` on npm 11.19.0 |
| Every workflow action pinned to a 40-character SHA | correct |
| `scripts/pre-publish-check.sh` reports honestly | **proven by sabotage** — given an `npm` that fails silently, it reports `COULD NOT VERIFY` and exits non-zero rather than passing |
| `npm ci --ignore-scripts && npm run build && npm test` in a clean public checkout | works — 279 tests, 0 failures |
| `npm pack --dry-run` file list | 37 files, 532.7 kB unpacked |
| The `npm stage` subcommand syntax | **WRONG in the old version** — fixed in steps 10 and 11 |
| The stated test count | **WRONG** — said 481, the public tree runs 279 |
| The stated package size | **WRONG** — said 640 kB, it is 532.7 kB |
| `npm audit signatures` placement | **WRONG** — it was checking the wrong directory |
| Both previously-unverifiable questions | **both now answered from primary sources** — steps 4 and 12 |

**Not rehearsed, because it cannot be without publishing:** anything that touches the registry —
steps 3, 6, and 9 through 13. Those are the steps that create the package, configure the trusted
publisher, and release.

---

## Part 1 — what changed since the last version of this document, and why

The last version of this plan was written around `npm publish` running in GitHub Actions, gated by
a human approving a deployment. That plan would have worked. Four things about it are now wrong or
weaker than they need to be.

### 1. npm's recommended release flow moved, on 2026-05-22

npm shipped **Staged Publishing**. Instead of a workflow publishing a package straight to the
registry, the workflow uploads it to a **staging queue**, where it is not installable by anyone.
A human then approves it, and the approval requires two-factor authentication.

Why this matters here specifically: the old plan's only final control was *"a human approves a
deployment on GitHub."* That control lives entirely inside GitHub. Whoever can approve a
deployment can release. ChainDrop — the npm worm that hit 444 packages on 2026-08-04 — did not
steal a publishing token. Its operators got write access to repositories, pushed to `main`, and
let each project's own release workflow sign the malware for them, complete with valid provenance.

Staged publishing moves the final authorisation **to a different system, behind a different
credential**: your npm account and the security key in your pocket. GitHub does not have it and
CI cannot present it. That is a genuinely stronger position, and it is why the release workflow
has been restructured.

The workflow can now **only stage. It has no ability to release.** Two independent controls
enforce that: the workflow contains no direct-release command (checked automatically by
`scripts/verify-hardening.sh`), and the trusted publisher you will configure in step 6 grants
*stage* permission only, so the registry itself would refuse a direct release even from a
workflow rewritten to attempt one.

> Sources: [Staged publishing](https://docs.npmjs.com/staged-publishing/) ·
> [`npm stage`](https://docs.npmjs.com/cli/v11/commands/npm-stage/) ·
> [GitHub changelog, 2026-05-22](https://github.blog/changelog/2026-05-22-staged-publishing-and-new-install-time-controls-for-npm/)

### 2. The release must run in the PUBLIC repository. Plainly: `djayamah/usewarden`, not `djayamah/warden`

**npm does not generate provenance for packages built in a private source repository — even when
the package itself is public.** This has been true since 2023-07-26. npm's stated reason is that
npmjs.com verifies the linked commit and repository when a reader looks at the provenance, and it
cannot verify a repository it cannot see.

So there is no arrangement in which the release runs in the private mirror and the published
artifact carries provenance. The release workflow lives in the public repository, and the
restructured `.github/workflows/release.yml` in this repo is the file that must end up there.
`package.json` already points `repository` at the public URL, which is the other half of the
requirement.

This is not a small point dressed up: **releasing from the private repo would silently produce an
artifact with no provenance at all**, and nothing would error.

> Sources: [GitHub changelog, 2023-07-25](https://github.blog/changelog/2023-07-25-publishing-with-npm-provenance-from-private-source-repositories-is-no-longer-supported/) ·
> [Generating provenance statements](https://docs.npmjs.com/generating-provenance-statements/)

### 3. The chicken-and-egg is real — and a standing token is NOT the answer

You cannot configure a trusted publisher for a package that does not exist. npm's own docs say
*"The package you're configuring must already exist on the npm registry."* Staged publishing has
the same requirement. The npm CLI issue asking for this
([npm/cli#8544](https://github.com/npm/cli/issues/8544)) is still open. The usual advice on the
internet is: create a throwaway token, publish once with it, then delete the token.

**You do not need to do that, and this plan does not.**

npm supports browser-based authentication from the command line. You log in once with
`--auth-type=web`, authenticate in the browser with your security key, and publish interactively.
No automation token is ever created, so there is no token to leak and none to remember to delete.

The one genuine cost: that first publish comes from your laptop, and **a laptop cannot generate
provenance** — provenance requires a supported cloud CI provider. So the plan below publishes a
**bootstrap version, `0.0.0`, under a tag that is not `latest`**, purely to bring the package into
existence. Nobody typing `npm install usewarden` will ever receive it. Then everything is wired
up properly, and the first real release — `0.1.0` — goes out through CI, with provenance, through
the staging queue, approved with your key. Step 13 deprecates `0.0.0` afterwards so the registry
tells the truth about it.

> Sources: [Trusted publishing](https://docs.npmjs.com/trusted-publishers/) ·
> [`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust/) ·
> [Web-based authentication for all npm commands](https://github.blog/changelog/2022-09-19-web-based-authentication-now-works-for-all-npm-commands/) ·
> [Accessing npm using 2FA](https://docs.npmjs.com/accessing-npm-using-2fa/)

### 4. The version number is `0.1.0`, and it should not be `1.0.0`

`0.1.0` for the first real release. The reasoning, so you can disagree with it:

- **Under semantic versioning, `0.x` means "the interface may still change".** That is a true
  statement about usewarden right now and `1.0.0` would be a false one. `1.0.0` is a promise that
  the command names, the `usewarden.yaml` schema, and the JSON output are stable, and nobody has
  used any of them yet.
- **Three of the six agent adapters have never been watched running.** Cursor, Copilot CLI and
  Codex CLI are built to each vendor's documented contract and covered by contract tests, and the
  README labels them UNVERIFIED-LOCALLY. That is honest, and it is not a 1.0.
- **Six real defects were found by live sessions in the last two days**, several in code that had
  a full green test suite over it. The rate of discovery has not flattened out yet.
- It matches the repository. `package.json` already says `0.1.0`, and the tag marking the verified
  state is `v0.1.0-verified`.

`0.0.0` is the bootstrap version and exists only so the package name is claimed and the trusted
publisher can be configured. It is tagged `bootstrap`, never `latest`, and deprecated at the end.

---

## READ THIS FIRST — the split, as of 2026-08-21

CLAUDE.md §7 was amended on 2026-08-21. Pushing to the public repository is no longer forbidden to
me, which moves most of this runbook from your column to mine. **The steps have not been renumbered
— that would break every reference to them — but each one now says whose it is, and the two columns
no longer interleave.**

**Your part is `ops/MANUAL-STEPS.md`.** One sitting, about 17 minutes, no point where you come back to
me. Do not work from the numbered steps below; they are the reference, and that page is the script.

| Step | Whose | Why |
|---|---|---|
| 0 | **mine, done** | measured: Node 25.5.0, npm 11.19.0, both above the floors |
| 1 | **yours** | npmjs.com account settings — UI only |
| 2 | **yours** | `npm login --auth-type=web` — interactive, needs your key |
| 3 | **yours** | the bootstrap publish — needs your key; no token may be created |
| 4 | **yours** | npmjs.com package settings — UI only, and only exists after step 3 |
| 5 | **mine, done** | read from the API: ruleset active, 0 bypass actors, release env with 1 reviewer |
| 6 | **yours** | `npm trust` — authenticates as you; cannot be delegated |
| 7 | **mine** | merge the workflow and bot PRs — authorized under the amended §7 |
| 8 | **mine** | dry-run the release workflow, read the file list |
| 9 | **mine** | stage the release |
| 10 | **yours** | inspect the tarball — you should look before you approve |
| 11 | **yours** | `npm stage approve` — exception 1, your key, permanently yours |
| 12 | **mine**, one line yours | I check provenance and install-as-a-stranger; you eyeball the commit hash |
| 13 | **mine** | deprecate the bootstrap version |

**The boundary is step 6.** Everything before it that is mine is done. Everything after it that is
mine is blocked until steps 1–6 exist, because a trusted publisher cannot be configured for a
package that does not exist, and the workflow cannot stage without one.

So: **your Part A/B/C (steps 1–6), then me (steps 7–9 and 13), then your Part D (steps 10–11).**
Two sittings for you, and the second one is three minutes.

---

## Part 2 — the steps

Total hands-on time: about 40 minutes, spread over two sittings. Steps 1–6 can be done any time;
steps 7–13 are the release itself.

You will need: your npm account, your hardware security key, and a browser.

**A note that matters:** several steps below will prompt you for a password or a two-factor code.
Those prompts are for you and your browser only. Do not type a password, a code, a token, or a
recovery code into any file, any chat window, or any terminal that is being recorded.

---

### Step 0 — [YOU, 2 min] Check your machine can run these commands at all

Every command in this document needs a recent `npm` and a recent Node. Nothing below says so,
which was a gap: if these are too old, the failures you get are confusing rather than obvious —
`npm trust` and `npm stage` simply do not exist in older versions, and the error just says the
command is unknown.

```bash
node --version    # must be 22.14.0 or higher
npm --version     # must be 11.15.0 or higher
```

**On this machine on 2026-08-21 these were `v25.5.0` and `11.19.0`, so you are fine** — this step
is here for the next machine, or the next person.

Why 22.14.0 and not 22.13.0: npm documents 22.14.0 as the floor for trusted publishing. That is a
different number from the `engines.node` field in `package.json`, which says `>=22.13.0` — that
one is the floor for **people who install usewarden**, and it is lower because that is where the
database feature usewarden uses stopped needing a special flag. Two different floors for two
different audiences, and they are not a contradiction.

```bash
git --version     # any recent version
gh --version      # optional, only if you use the GitHub CLI rather than the website
```

> Source: [Trusted publishing](https://docs.npmjs.com/trusted-publishers/) — *"Trusted publishing
> requires npm CLI version 11.5.1 or later and Node version 22.14.0 or higher."* Checked
> 2026-08-21.

---

### Step 1 — [YOU, 5 min] Check three settings on your npm account

Go to **npmjs.com → your avatar → Account**.

1. **Two-factor authentication** must be on, using a **security key or passkey** — not an
   authenticator app code typed by hand, and never SMS. (npm stopped accepting new authenticator-
   app enrolments in September 2025; if yours is a security key already, you are fine.)
2. Under **Two-factor authentication**, the mode must be **"Authorization and writes"**, not
   "Authorization only".
3. Go to **Account → Tokens** and confirm the list is **empty**. If there is anything there,
   delete it. With the plan below, no token needs to exist at any point.

**How you know it worked:** the tokens page says you have no tokens, and the 2FA section shows a
security key.

---

### Step 2 — [YOU, 3 min] Log in to npm from your machine, using the browser

Open a terminal and run:

```bash
npm login --auth-type=web
```

Press Enter when it offers to open your browser. Authenticate with your security key.

**How you know it worked:**

```bash
npm whoami
```

prints your npm username.

---

### Step 3 — [YOU, 5 min] Create the package with the bootstrap version

This is the one step that exists purely to defeat the chicken-and-egg. It publishes version
`0.0.0` under the tag `bootstrap`, which means `npm install usewarden` will **not** install it —
in fact, until step 11, `npm install usewarden` will fail with "no matching version", which is
correct and intended.

From a clean checkout of the **public** repository. "A clean checkout" means a fresh copy
downloaded from GitHub, with nothing edited in it — not the working folder on this machine, which
has uncommitted experiments in it more often than not. If you do not already have one:

```bash
cd ~/Desktop
git clone https://github.com/djayamah/usewarden.git
cd usewarden
```

Then:

```bash
git status                     # must say "nothing to commit, working tree clean"
npm ci --ignore-scripts
npm run build
npm test                       # see the note below on the number
```

`--ignore-scripts` is not decoration. It tells npm not to run any code that a dependency asks to
have run at install time. That is the exact mechanism the ChainDrop worm used on 2026-08-04, and
usewarden ships no such scripts itself — so this flag costs you nothing and closes the hole.

Then set the bootstrap version and send it, with the tag:

```bash
npm version 0.0.0 --no-git-tag-version
npm publish --tag bootstrap --access public
```

You will be asked to authenticate. Do it with your security key.

Then put the version back, so the repository is not left claiming to be `0.0.0`:

```bash
npm version 0.1.0 --no-git-tag-version
git checkout -- package.json package-lock.json   # or commit it; either is fine
```

**About that test number.** Earlier versions of this document said "481 tests". That is the count
in the **private** repository. The **public** repository ships a subset, and its suite is smaller —
**279 tests today**, or **310** once the triage-bot PR in `ops/PUBLIC-BOT-FIX-PR.md` is merged.
Measured, not estimated. What matters is that the last line says `fail 0`; the total is not
something to match against a number in a document. (The public README's own claim of 427 was
wrong for the same reason and is corrected in that PR.)

**How you know it worked:**

```bash
npm view usewarden dist-tags
```

shows a `bootstrap` tag and **no `latest` tag**.

**It shows `latest`, and that is the state today** — `latest` is `0.0.0`. The `--tag bootstrap`
flag did not take effect, so the version anyone typing an install command receives is a build made
on your laptop with no provenance attached. It is not dangerous — you made it, and you know what is
in it — but it is not what this plan intends to ship.

**CORRECTED 2026-08-24 — this does NOT need a `dist-tag` step, and it used to say it did.**
Approving the staged `0.1.0` moves `latest` by itself. npm's reference for `npm stage`
(<https://docs.npmjs.com/cli/v11/commands/npm-stage>, read 2026-08-24) says the dist-tag is fixed at
**stage** time and that "if no tag is provided, the `latest` tag is used by default"; `release.yml`
runs `npm stage publish` with no `--tag`, and `0.1.0` is the highest semver on the packument, so it
is not the pre-release case that would error. `npm stage approve` has no `--tag` of its own.

So there is nothing to do here. Step 12 verifies it landed. See D-215.

---

### Step 4 — [YOU, 2 min] Lock the package down to interactive publishing only

Now that the package exists, it has its own settings page.

Go to **npmjs.com → usewarden → Settings → Publishing access**, and choose:

> **Require two-factor authentication and disallow tokens**

This is the setting that makes a stolen token useless, because it makes tokens unusable for
publishing at all.

**This was flagged unverifiable in the previous version of this document. It is now answered,
from npm itself.** The trusted-publishing documentation states:

> *"The 'disallow tokens' setting only affects traditional token authentication. Your trusted
> publishers will continue to work normally, as they use OIDC tokens."*

So the two are compatible by design, and you can turn this on without worrying about breaking
step 6. In plain terms: this setting switches off the old way of publishing (a long-lived secret
string that anyone who copies it can use). The new way — the one you are setting up in step 6 —
does not use one of those, so it is unaffected.

> Source: [Trusted publishing](https://docs.npmjs.com/trusted-publishers/), checked 2026-08-21.

---

### Step 5 — [YOU, 2 min] Confirm the repository settings are still in place

These were verified on 2026-08-19 and should still be true. Check, do not assume:

Go to **github.com/djayamah/usewarden → Settings**:

1. **Rules → Rulesets** — `protect-main` is **Active**, and its bypass list is empty. Nobody,
   including you, can push straight to `main`.
2. **Environments → release** — exists, and has **you** as a required reviewer.

**How you know it worked:** both are already configured; you are confirming, not creating.

---

### Step 6 — [YOU, 3 min] Configure the trusted publisher — **stage only**

This is the step that makes the release workflow able to stage and unable to release.

Run:

```bash
npm trust github usewarden \
  --repo djayamah/usewarden \
  --file release.yml \
  --env release \
  --allow-stage-publish
```

Read that command once more before running it. **`--allow-stage-publish` is present and
`--allow-publish` is absent, and that is the whole point.** With only stage permission, the
registry will refuse a direct release from CI even if the workflow file is later changed to
attempt one. It is the control that does not depend on the workflow file staying honest.

If you would rather use the website: **npmjs.com → usewarden → Settings → Trusted publishing →
GitHub Actions**, with organisation `djayamah`, repository `usewarden`, workflow file
`release.yml` (the filename only, not a path), environment `release`, and under **Allowed
actions** tick **`npm stage publish`** and leave **`npm publish`** unticked.

**How you know it worked:**

```bash
npm trust list usewarden
```

shows one entry, pointing at `djayamah/usewarden` and `release.yml`, with stage permission only.

---

### Step 7 — [YOU, 10 min] Get the release commit onto `main`

> ### This step is a hard blocker, not a formality
>
> **The release workflow on the public repository today is still the OLD one.** Checked against
> GitHub on 2026-08-21 by reading the file the repository actually serves:
>
> ```
> node-version: '22.13.0'
> run: npm publish --provenance --access public
> ```
>
> So the live workflow **releases directly** — the thing this whole plan exists to prevent — and
> is pinned one patch **below** npm's documented Node floor. The fixes exist in the private
> repository; the private repository is not where the release runs.
>
> Consequences if you skip or delay this step:
>
> - **Steps 8 and 9 will not make sense.** They tell you to choose a mode of `dry-run` or `stage`.
>   The workflow that is live has no mode input, so there is nothing to choose.
> - **After step 6, the registry will refuse the workflow.** You will have granted the trusted
>   publisher *stage* permission only, and the live workflow attempts a direct release. The
>   refusal is the control working correctly, and it is baffling without this warning.
>
> The branch is prepared and verified: **`ops/PUBLIC-RELEASE-WORKFLOW-PR.md`**, branch
> `release-staged`, one commit. Merge that, and `ops/PUBLIC-BOT-FIX-PR.md` if you want the bot fix
> in the same release, then continue here.
>
> **After merging, read back what actually landed** rather than trusting the merge:
>
> ```bash
> gh api "repos/djayamah/usewarden/contents/.github/workflows/release.yml?ref=main" \
>   --jq .content | base64 -d | grep -nE "npm (stage|publish)|node-version"
> ```
>
> You want `npm stage publish` and `22.14.0`.

The public repository's `main` cannot be pushed to directly, which is deliberate. So:

1. Open a pull request containing the restructured `.github/workflows/release.yml`, the updated
   `.npmrc`, and whatever else is in this release.
2. Wait for the CI checks to go green.
3. Read the diff yourself. This is the commit that provenance will point at, and **provenance
   proves which commit was built, not that the commit was a good idea.**
4. Merge it.

---

### Step 8 — [AUTOMATED, then YOU] Run the release workflow in **dry-run** first

Go to **github.com/djayamah/usewarden → Actions → release → Run workflow**, leave the mode set to
**`dry-run`**, and start it.

It will pause and ask you to approve the `release` environment. Approve it.

It then builds, runs the full test suite, runs `scripts/pre-publish-check.sh`, and prints the complete
list of files that would go into the package. **It does not touch the registry.**

**Now read that file list. Every line.** This is the check that provenance cannot replace. For
each entry, ask: *do I know why this is in the package?* You are looking for anything that should
not ship —

- no `.env` of any kind, no `.npmrc` containing a credential, no `~/.usewarden`
- no `verification/`, no `fixtures/`, no `src/`, no `tests/`, no `.git`
- **37 files, 532.7 kB unpacked, 344.3 kB packed** — measured from the public tree on
  2026-08-21 with `npm pack --dry-run`. A file or two either way is normal; a jump of hundreds of
  kilobytes is not.

**If anything is on that list you cannot explain, stop.** That is a red flag and the release does
not go out today.

---

### Step 9 — [YOU, 1 min] Run it again, in **stage** mode

Same place, but set the mode to **`stage`**. Approve the environment gate again.

**How you know it worked:** the workflow's summary ends with a note saying nothing is installable
yet, and it prints the staged package's ID.

Nothing has been released. `npm install usewarden` still does not find a normal version.

---

### Step 10 — [YOU, 5 min] Look at the actual tarball before approving it

```bash
npm stage list usewarden              # this one DOES take the package name
npm stage view <the-stage-id-from-the-list>
```

**Note the difference between those two lines.** `npm stage list` takes the package name;
`view`, `download`, `approve` and `reject` take **only the stage id** — no package name. An
earlier version of this document put the package name on all of them, and those commands would
have failed with a usage error. Confirmed against `npm stage --help` on npm 11.19.0 and against
npm's own CLI reference.

If you want to be thorough — and for a first release you should be — download the exact bytes that
are waiting and look inside. Do this in an empty directory, not in the repository:

```bash
mkdir -p ~/Desktop/usewarden-check && cd ~/Desktop/usewarden-check
npm stage download <stage-id>
tar -tzf usewarden-0.1.0.tgz          # the file list, again, from the real artifact
tar -xzf usewarden-0.1.0.tgz          # extracts into ./package
node package/dist/src/cli.js --version
node package/dist/src/cli.js demo
```

The last two lines run the thing a stranger would install, from the exact file that would be
published. If `--version` prints `0.1.0` and `demo` shows incident cards, the artifact works.

---

### Step 11 — [YOU, 2 min] Approve it. This is the release.

```bash
npm stage approve <stage-id>
```

Again: **no package name** — just the stage id.

You will be asked for two-factor authentication. **This prompt is the release.** Everything before
it was reversible; this is not.

You can also do it from **npmjs.com → usewarden → Staged Packages**, which shows the same thing
in a browser.

**If something looks wrong and you do not want to release it**, do not just walk away — the staged
package sits in the queue. Clear it:

```bash
npm stage reject <stage-id>
```

Rejecting costs nothing. Nothing was ever installable, and you can stage again after fixing
whatever you found.

---

### Step 12 — [YOU, 5 min] Verify what actually landed

```bash
npm view usewarden dist-tags          # latest should now be 0.1.0
```

**If `latest` is still `0.0.0` here, stop and tell me** rather than running `npm dist-tag add` to
patch it. The approve is documented to move the tag on its own (D-215); if it did not, something
about the stage differed from what npm documents and that is worth understanding before papering
over it.

Then open **npmjs.com/package/usewarden** in a browser and look for the **provenance** section. It
should name `djayamah/usewarden`, the release workflow, and the exact commit you merged in step 7.

**Check the commit hash matches the one you actually reviewed.** That is the entire point of
provenance, and reading the badge without reading the hash gets you nothing.

**This was the second thing flagged unverifiable, and it is now answered.** The npm team's own
GA announcement states:

> *"Provenance is generated for staged packages on parity with direct publishes — there is no
> difference in provenance behavior between `npm publish` and `npm stage publish`."*

So the attestation is created when the workflow stages, and it survives approval. Keep doing the
check — its purpose is to confirm the **commit hash**, not to confirm the feature exists — but you
are no longer testing whether the mechanism works at all.

**If the provenance section really is missing**, the likely causes, in the order worth checking:
the release ran in the private repository rather than the public one (npm does not generate
provenance from a private source repository), or the trusted publisher configured in step 6 does
not match the workflow file name and environment exactly.

> Source: [npm staged publishing GA announcement](https://github.com/orgs/community/discussions/196675),
> checked 2026-08-21.

Finally, install it the way a stranger would, in a directory that is not this project:

```bash
cd $(mktemp -d)
npm init -y >/dev/null
npm install usewarden
npm audit signatures                  # verifies the REGISTRY SIGNATURE on what you just installed
npx usewarden --version
npx usewarden demo
```

**`npm audit signatures` belongs here, not in the repository.** It checks whatever is installed in
the directory you run it from. Run inside the usewarden repo — which is what an earlier version of
this document told you to do — it audits usewarden's three build-time dependencies and says
nothing whatsoever about usewarden itself. Run here, after installing, it checks the exact thing
you just pulled from the registry.

---

### Step 13 — [YOU, 1 min] Retire the bootstrap version

```bash
npm deprecate usewarden@0.0.0 "bootstrap version used only to create the package - use 0.1.0 or later"
```

Anyone who somehow installs `0.0.0` now gets a warning explaining what it is. The registry ends up
telling the truth: one deprecated bootstrap version with no provenance, and one real release with
provenance, which is `latest`.

---

## Every release after this one

Steps 1–6 and 13 never happen again. A release is:

1. **[YOU]** Open a PR with the version bump and the changelog. Get the CI green. Read the diff.
2. **[YOU]** Merge it.
3. **[YOU]** Actions → release → `dry-run`. Approve the environment. **Read the file list.**
4. **[YOU]** Actions → release → `stage`. Approve the environment.
5. **[AUTOMATED]** The package lands in the staging queue. Nobody can install it.
6. **[YOU]** `npm stage download`, look at the tarball, then `npm stage approve` with your key.
7. **[YOU]** Check the provenance commit hash on npmjs.com.

---

## Any one of these stops a release

- The file list contains something you cannot explain.
- The tarball grew a lot and nothing in the changelog explains why.
- A dependency appeared that is not in `docs/DEPENDENCY-BUDGET.md`. usewarden has **zero** runtime
  dependencies; one appearing is a significant event, not a detail.
- `scripts/verify-hardening.sh` reports a control it **could not check**. An unverifiable control
  is a failed control.
- A workflow action is pinned to a tag rather than a 40-character commit hash.
- The provenance commit does not match the commit you reviewed.
- You are in a hurry.

---

## If you ever think a release was compromised

1. `npm deprecate usewarden@<version> "compromised - do not use"` — do this first. Deprecation is
   instant. Unpublishing has a 72-hour window and destroys the version history people need to work
   out what they installed.
2. Revoke every npm and GitHub credential.
3. Publish a GitHub Security Advisory on the repository.
4. Post the affected version range and the exact commit hash everywhere the release was announced.
5. Only then work out what happened.

---

## What is in this repository to support the above

| File | What it does |
|---|---|
| `.github/workflows/release.yml` | Stages only. Cannot release. Node pinned to 22.14.0, the documented floor for both trusted and staged publishing — the previous pin of 22.13.0 was one patch below it. |
| `scripts/pre-publish-check.sh` | Refuses a dirty tree, asserts no install scripts, checks the lockfile, prints the full file list. Reports **COULD NOT VERIFY** rather than passing when it cannot read something. |
| `scripts/verify-hardening.sh` | 46 controls (40 PASS, 2 FAIL, 4 UNVERIFIED on 2026-08-21). Now also checks that the workflow stages rather than releases, that it carries no direct-release command, and that the Node pin meets the publishing floor. |
| `.npmrc` | `min-release-age=7` days, plus npm 11.15.0's install-time source controls. `allow-directory` is deliberately left at its default — setting it to `none` breaks `npm pack` itself, which is documented in the file. |
| `launch/PUBLISH-CHECKLIST.md` | The older, more discursive version of this document. Kept for the reasoning; this file is the runbook. |
