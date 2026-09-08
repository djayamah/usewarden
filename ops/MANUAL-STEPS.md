# Manual steps — the canonical list

**This file supersedes `ops/WHAT-I-STILL-NEED-FROM-YOU.md` and `ops/YOUR-BLOCK.md`.** Both are now
pointers here. If they disagree with this page, this page is right.

**The rule that governs this list** is CLAUDE.md §8: before anything is written here, an autonomous
route has to have been looked for in primary sources and not found. **An item with no
proof-of-impossibility does not belong on this list — it gets automated instead.** Every entry
below carries what it is, why it cannot be automated, the primary source proving that, the date
checked, and a copy-pasteable command or click path that assumes you know nothing.

Rebuilt from scratch **2026-08-24** and cut again the same day. Everything was re-verified on that date, not carried forward.

---

## There are 5 things, and two of them take eight minutes

| # | What | Time | Blocking? |
|---|---|---|---|
| 1 | Two npm account settings, in a browser | ~6 min | **Yes — blocks the release** |
| 2 | Approve the staged release | ~2 min | **Yes — this IS the release** |
| 3 | Write the next piece | yours | No |
| 4 | One line into `~/.usewarden/usewarden.yaml` so the record backs itself up | ~1 min | No — and **dormant since 2026-08-29**, see the note on it |
| 5 | Delete two empty files usewarden left in your home directory | ~10 sec | No — they are inert litter |

Nothing else. **Eight things that were on this list are gone** — see *What came off, and why* at
the bottom. That section matters more than this one, because it is the evidence the list is short
because it was attacked rather than because it was written optimistically.

## 1. Two npm account settings — in a browser, ~6 minutes

### 1a. Configure the trusted publisher

**Why this cannot be automated:** npm's trusted-publisher configuration exists only in the website
UI. There is no CLI command and no public REST API for creating, reading, or updating it.

> **Primary source:** <https://docs.npmjs.com/trusted-publishers> — read **2026-08-24**. The page
> documents the whole flow as "Navigate to your package settings on npmjs.com and find the
> 'Trusted Publisher' section", and lists no CLI or API equivalent anywhere on it.

Reading the setting needs an authenticated npm session too, so I cannot even check it for you —
which is why `verify-hardening.sh` reports it as UNVERIFIED rather than PASS.

**Click path, assuming nothing:**

1. Open <https://www.npmjs.com/package/usewarden/access> in a browser.
2. Sign in if it asks. It will want your security key.
3. Find the section headed **Trusted Publisher**.
4. Set **Provider** to `GitHub Actions`.
5. Fill the three fields exactly:
   - Organization or user: `djayamah`
   - Repository: `usewarden`
   - Workflow filename: `release.yml`
6. Under **Allowed actions**, tick **`npm stage publish`** and leave **`npm publish`** UNTICKED.
   This is the control that makes a direct release impossible even from a rewritten workflow. If
   the UI will not let you save with only one ticked, tick only stage publish and save; if it
   refuses entirely, stop and tell me, because that changes the security design.
7. Save.

### 1b. Require 2FA and disallow tokens

**Why this cannot be automated:** same page, same reason — an account setting behind an
authenticated web session, with no API. CLAUDE.md §2 forbids me holding or prompting for the
credential that would be needed.

1. On the same page, find **Publishing access**.
2. Choose **Require two-factor authentication and disallow tokens**.
3. Save.

**How you know both worked:** tell me, and I will run `./scripts/verify-hardening.sh`. The two rows
that currently say UNVERIFIED are these. They will still say UNVERIFIED — npm publishes no API for
either — but the release will stop failing at the trusted-publisher check, which is the real signal.

---

## 2. Approve the staged release — ~2 minutes, and this is the release

**Why this cannot be automated, permanently:** CLAUDE.md §7 exception 1. It is not a technical
limit and it is not up for re-checking; it is the boundary itself.

> **Primary source for the technical half:** <https://docs.npmjs.com/cli/v11/commands/npm-stage> —
> read **2026-08-24**. `npm stage approve` is documented as requiring 2FA. Your 2FA is a hardware
> key, which by design cannot be presented by anything that is not you, physically.

**When it is ready, the command is:**

```bash
cd ~/dev/warden
npm stage list usewarden          # shows the staged id
npm stage approve <the-id-it-printed>
```

It will ask for your security key. Touch it.

**Then check it worked:**

```bash
npm view usewarden dist-tags      # latest should now be 0.1.0
```

**You do NOT need to run `npm dist-tag add` afterwards.** That step was on this list for weeks and
it was wrong — see **What came off** below. Re-confirmed against npm's own reference on 2026-08-24,
which now states it outright: *"The tag is an immutable property of the staged package"* and *"If no
tag is provided, the `latest` tag is used by default"*. `release.yml` passes no `--tag`, and `0.1.0`
is the highest semver on the registry, so approving the stage moves `latest` by itself. If `latest` is somehow still `0.0.0` after the approve,
stop and tell me rather than fixing it by hand; it would mean something about the stage differed
from what npm documents.

### The trap that has already been misread once — read this before you touch anything

**Three different things fail in ways that look identical, and two of them are not problems.**

| What you see | What it usually means | How to tell |
|---|---|---|
| The workflow run shows **FAILED** but the stage went through | A successful stage reports as a failed run. The publish step exits non-zero after the stage id is minted (D-198). | Look for `(staged with id …)` in the log. If it is there, the stage exists. |
| `npm stage list` errors about auth | **Your npm login session expired.** This is not the stage. CI publishes over OIDC and never uses your session, so a session problem can only ever affect the commands *you* type. | `npm whoami`. If that fails, run `npm login --auth-type=web` and try again. |
| `409 Cannot stage previously published version` | Either a previous stage is still sitting in the queue, or the version is genuinely spent. | `npm stage list usewarden` — see below. |

The middle row is the trap. An expired session makes a perfectly good stage look absent, and the
natural response — re-stage — is the one action that produces the 409 in the next row. **Check
`npm whoami` first, every time.**

### One thing still open, and one command settles it

`npm stage publish` for `0.1.0` returns `409 Cannot stage previously published version` even though
the public registry has no `0.1.0` at all. Either the earlier reject has not propagated, or a
rejected stage burns the version number permanently. I deliberately did not test it by staging
`0.1.1`, because that would put another artifact in your queue to answer a question one read
answers. Run this and paste me the output:

```bash
npm stage list usewarden
```

If the version is burned, the fix is to move to `0.1.1` everywhere and re-cut the GitHub Release. I
can do all of that; I just cannot see the staging queue. (D-199, D-201.)

---

## 3. Write the next piece — yours, and the only creative work left

Everything technical is done. The canonical home for the series is **live**:

<https://djayamah.github.io/usewarden/writeups/>

Piece 1 is published there and [Discussion #17](https://github.com/djayamah/usewarden/discussions/17)
now links to it as the canonical copy. Pieces 2 to 8 are drafted in `launch/writeups/` and the next
one is due **2026-09-22**.

**Why this is on your list and not mine.** The drafts exist; what they need is your judgement about
what to say and when. Publishing one is mechanical after that — I render it, deploy it, and open
the Discussion.

## 4. One line so the record keeps backing itself up — ~1 minute

> **DORMANT since 2026-08-29.** usewarden's hooks were removed from this machine that day
> (`ops/DOGFOOD.md`), so no new sessions are being recorded and there is nothing new to back
> up. The existing record is untouched and still backed up. Do this step if you reinstall,
> not before.

**This is not urgent and it does not block anything.** A verified copy of the record is already
sitting inside `~/dev/warden/corpus-backup/`, which the nightly offsite job already reaches, and a
git hook in this repository refreshes it whenever you commit here. This step extends that to agent
sessions in *other* projects, on days when nothing is committed here.

**Why this cannot be automated:** the setting has to go in `~/.usewarden/usewarden.yaml`, which is
**outside `~/dev/warden`**, and CLAUDE.md §3 permits writes outside the repository only for the
product's own hook registrations, each preceded by a timestamped backup and covered by a proven
`usewarden restore-configs`. A policy key is neither of those things. That is your own rule and it
is the reason this line is here rather than done.

> **Primary source:** `CLAUDE.md` §3, row *"Writes outside `~/dev/warden`"*, and §7's closing
> paragraph — "§1 (path rules), §2 (credentials), §3 (hard limits) … are unchanged and remain
> binding in full". Checked **2026-08-26**.
>
> It cannot go in this repository's own `usewarden.yaml` either, and that is a security property
> rather than an inconvenience: `backup.dir` names a directory that the whole cross-project record
> is copied into, so a repository that could set it would have a one-line way to walk the record
> out. `src/policy/load.ts` refuses it from a repo policy — even a trusted one — and says so.

**Do this, exactly:**

Open a Terminal and paste this one line. It appends four lines to the file and changes nothing else:

```bash
printf '\nbackup:\n  dir: ~/dev/warden/corpus-backup\n  every_hours: 12\n  keep: 7\n' >> ~/.usewarden/usewarden.yaml
```

Then check it took:

```bash
usewarden policy | grep -A3 backup
```

You should see `dir` pointing at `~/dev/warden/corpus-backup`. If instead you see an error
mentioning `usewarden.yaml`, the file already had a `backup:` section — tell me and I will fix it
rather than you editing YAML by hand.

**To undo it**, open `~/.usewarden/usewarden.yaml` in TextEdit and delete the four `backup:` lines.
Nothing else depends on them.

---

## 5. Delete two empty files usewarden left in your home directory — ~10 seconds

**Nothing depends on this and nothing is at risk if you never do it.** The two files are 3 bytes
each and contain `{}`. They hold no hooks, so nothing can run from them.

**What they are.** When usewarden was installed on 2026-08-20 it needed a Gemini CLI config and a
Codex CLI config to register in, and neither existed, so it created them. `usewarden uninstall`
removed its hook entries correctly but has no notion of a file it created itself — only of a
settings *key* it created — so the two empty shells stayed. `verification/uninstall-proof-2026-08-29.txt`
is the per-file proof, and D-262 is the code fix that makes this step unnecessary in future.

**Why this cannot be automated:** it is a **deletion** in your home directory, outside
`~/dev/warden`. CLAUDE.md §3 permits writes outside the repository only for the product's own hook
registrations, each preceded by a timestamped backup and covered by a proven
`usewarden restore-configs`. Removing a leftover file is neither. Same fence as step 4, and the
same reason: your rule, not my judgement.

> **Primary source:** `CLAUDE.md` §3, row *"Writes outside `~/dev/warden`"*. Checked **2026-08-29**.

**Before you delete, check they are still empty** — if you have started using Gemini CLI or Codex
CLI since, they will have your settings in them and you should keep them:

```bash
cat ~/.gemini/settings.json ~/.codex/hooks.json
```

If that prints exactly `{}` twice and nothing else, they are safe to remove:

```bash
rm ~/.gemini/settings.json ~/.codex/hooks.json
```

If it prints anything else, **stop** — those are your own settings now. Leave them alone; the
leftover `{}` was harmless anyway.

---

## Not steps — two things to accept, or not

Neither is an action. Both are states you should know about rather than tasks you should do.

**The public history carries two identifying strings.** One blob (`92b9d69e`) and one commit header
(`01275ca5`, authored by this machine's Bonjour hostname). Neither is a credential or a private
path. Neither is fixable by a pull request — only by rewriting public history, which §7 condition 3
forbids me from doing under any circumstance, and which on a public repo leaves the old objects
fetchable by SHA for a long time regardless. `verify-hardening.sh` pins the baseline at exactly
`1 blob + 1 commit header`, so if that number ever grows it is loud. (D-142, D-145.)

**The `gh` token is over-scoped, and `verify-hardening.sh` is right to FAIL on it.** It carries
`repo` and `workflow`, which is what lets me push, merge, set repository variables, touch workflow
files, and — as of today — approve deployments. That FAIL clears only when you decide you no longer
want automated changes here. It is a true statement about the posture, not a defect, and it should
stay visible rather than be explained away.

---

## What came off, and why

This is the part worth reading. Six items that were on your list are gone. Five were never
constraints; one was finished.

| Was on the list | Why it is gone | Date checked |
|---|---|---|
| **A hosting login for the write-up site** | **Not needed.** GitHub Pages is free for public repositories and is enabled through `POST /repos/{owner}/{repo}/pages` with the token already in use. The site is live. D-227. | 2026-08-24 |
| **Deploying the metrics aggregator** | **Cut to post-launch.** It is a service, so Pages cannot host it and every free tier needs an interactive login. It also achieves nothing yet: telemetry is opt-in and off, the package is unpublished, and there are no users — deploying moves the figure from "cannot be counted" to "counted: zero". D-228. | 2026-08-24 |
| **Opening a test issue for the support bot** | **Cut.** Optional, and the first real issue anyone opens tests it for free. The bot's evals are green against the live public corpus and the kill switch is one command. D-228. | 2026-08-24 |
| **`npm dist-tag add usewarden@0.1.0 latest`** | **Not needed at all.** `npm stage publish` takes the dist-tag at STAGE time and defaults to `latest`; `release.yml` passes no `--tag`. Re-confirmed against current npm docs this run. D-215, D-231. | 2026-08-24 |
| **Approving the GitHub deployment** | **Automated.** `scripts/approve-deployment.sh` does it with the existing token. D-191, D-216. | 2026-08-24 |
| **Applying the §7 amendments** | **Done**, all three, committed by you. | 2026-08-24 |
| **The bootstrap publish of `0.0.0`** | **Done.** | 2026-08-24 |
| **`gh` token rotation, npm 2FA, npm email, SECURITY.md contact** | **Done**, 2026-08-20/21. | 2026-08-24 |

### The general lesson, since it has now happened twice

Both of today's removals were **claims that had never been checked**, sitting on your list looking
like constraints. D-191 said it first: *"every remaining item on that page is a claim that can be
checked, not a constraint that is known."* The dist-tag step survived that pass and did not survive
this one. So the discipline is now written into CLAUDE.md §8 rather than remembered, and this page
carries a dated primary source per row so the next run has to re-attack it rather than inherit it.
