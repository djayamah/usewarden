# Baked surfaces — what a future release must carry

Written 2026-08-26. Audited that day against the tree at that commit; items 7 and 8
added 2026-09-08 (D-274).

**Why this file exists.** Some of the text a user reads is *frozen at publish time* and cannot be
corrected afterwards without shipping a new version. D-239 established this the hard way: the npm
page said "Not on npm yet" and there was no route to fix it — no `npm readme` command, no registry
API for it — so `0.1.1` was published for that reason and nothing else. A stale sentence in a baked
surface is therefore a **release defect**, not a typo, and the moment to catch one is before the
release rather than after.

---

## Which surfaces are baked, and which are live

| Surface | What a user sees | Baked? |
|---|---|---|
| `README.md` inside the tarball | the whole npmjs.com package page | **BAKED** — needs a version bump |
| `package.json` `description` | the one sentence under the package name on npmjs.com | **BAKED** |
| `package.json` `keywords` | npm search | **BAKED** |
| `dist/src/cli.ts` `USAGE` | `usewarden --help` | **BAKED** |
| every string the CLI prints | `status`, `demo`, `week`, receipts, incident cards | **BAKED** |
| `SECURITY.md` in the tarball | the disclosure policy a researcher reads | **BAKED** |
| `README.md` on GitHub | the repository landing page | live — edit any time |
| `site/index.html` | <https://djayamah.github.io/usewarden/> | live — redeploy any time |
| the GitHub Release body | the release notes | live — editable |
| Discussions | the write-up series | live — editable |

**The trap is the first row and the seventh row being the same file.** Editing `README.md` fixes
GitHub instantly and npmjs.com **never**. Everything below was written to `README.md` today and is
therefore live on GitHub and absent from npm until the next publish.

---

## What the next release must carry

Everything in this list is in the tree now and is **not** on the npm page, because the npm page is
whatever `0.1.1` shipped.

| # | Change | Where | Why it matters on npm specifically |
|---|---|---|---|
| 1 | **The honest native-controls comparison** — a single-agent Claude Code user gets equivalent blocking from deny rules and better protection against out-of-scope writes | `README.md`, new section after *Is this your week?* | This is the claim most likely to be checked by a sceptical reader who arrived from npm. It is the whole point of the edit that it reaches them **before** they install. |
| 2 | **The shell-redirect gap** and **the subprocess gap** | `README.md` *What usewarden cannot catch* | Two limitations a reader can discover in five minutes. Discovering them unaided costs the credibility of every other bullet in that list. |
| 3 | **`forbidden_paths` guards the file tools, not the shell** | `README.md` *What usewarden cannot catch* | A user who puts `~/Documents` on their forbidden list today believes `cat ~/Documents/x` is blocked. It is not. This is the most actionable correction in the set. |
| 4 | **The false-positive finding** — 35 of 59 recorded incidents fired on text about a command, and the record cannot be replayed to say whether they still would | `README.md` FAQ and the record section | It changes what a user should expect in week one, which is exactly what a package page is for. |
| 5 | **`usewarden backup`** | `README.md` command table, `cli.ts` USAGE | A new command absent from `--help` in the published build is a feature nobody finds. |
| 6 | The stale test count, corrected to 747 | `README.md` | **And the reasoning about it was wrong, twice.** It was first deleted on the grounds that nothing recomputed it. `scripts/verify-all.sh:213` recomputes it — the check was written for exactly this, after the number went stale three times during the build — so deleting it broke its own verifier. Restored, and the rule below is unchanged: a number belongs on a frozen surface **when something checks it**, and this one is checked. |
| 7 | **The pricing and privacy answer, on the FIRST SCREEN** — *Free. Local. No account.* as a block directly under the opening paragraph, plus the same three answers on the landing page | `README.md` top, `site/index.html` hero | **The highest-value row in this table.** Two strangers independently opened issues asking whether usewarden costs money (#9 on 2026-08-20, #14 on 2026-08-21) before asking anything else. The answers already existed — in the FAQ, roughly 140 lines down. A reader arriving on npmjs.com sees the README from the top and decides in the first screen; an answer they have to scroll for is an answer they did not get. This is the one item here that changes whether someone installs at all. |
| 8 | `package.json` `description` now leads with **Free** | `package.json` | The one sentence under the package name in npm search results and on the package page. The published `0.1.1` sentence leads with "Stop your AI coding agent…" and never says free, so npm's own search snippet cannot answer the question either. |

**Items 7 and 8 change that judgement, and this is the note for whoever reads it next.**

Until 2026-09-08 the assessment above was right: nothing in the list justified a release by itself.
Two things have happened since. The first is evidence rather than reasoning — **the only unsolicited
human signal this project has received is two people, independently, asking whether it costs
money.** Not a bug report, not a feature request; a question the package page fails to answer in the
place they were looking. The second is that the fix is now in the tree and live on GitHub and the
site, so npmjs.com is the only surface still giving the old answer — and npm is precisely where a
stranger meets the package first.

That is not a reason to cut a release *today*. It is a reason to stop calling this list "nothing
urgent": item 7 is the first entry here with measured demand behind it, and when a release happens
for any reason, it goes at the top of the notes. Item 3 remains the most important correctness fix.
Do not cut a release just for these; do not let a release go out without them.

---

## The audit that produced this

Run these four and read the output, rather than trusting this page:

```bash
npm test                                   # tests/claims.test.ts guards every surface below
node scripts/probe-native-gap.mjs          # what actually fires, measured against the hook binary
node scripts/classify-incidents.mjs        # whether the record's blocks were real
node dist/src/cli.js --help                # the banner as a published user would see it
```

**What is guarded automatically now**, so this page does not have to be remembered:

- `tests/claims.test.ts` asserts every baked surface — README, `package.json`, `cli.ts`, the site,
  the post drafts — carries none of the five "not published yet" phrasings, and that the README
  still carries the honest comparison and both of its primary sources.
- `tests/site.test.ts` asserts the landing page does not claim to be unpublished, and that its
  sabotage numbers match the suite that runs.

**What is not guarded, and cannot easily be:** whether the text on npmjs.com matches the text in
this tree. Reading it requires the registry, and comparing it requires knowing which version the
reader is looking at. The honest control is procedural: this page is the checklist, and the release
runbook points at it.

---

## The rule this run adopted

**State a number only where something verifies it.**

`14 of the 17 sabotage scenarios` stays specific, because `tests/site.test.ts` parses the suite and
fails when the claim and the suite disagree. The test count stays specific too — `verify-all.sh`
greps it out of the README and compares it against the run.

**The instructive part is that this rule was applied wrongly the first time.** The stale count was
*deleted* on the assumption that nothing verified it. Something did, and removing the number turned
a passing check into a failing one. The rule is right; the premise was not checked. Before deciding
a number is unverified, grep for it — which is the same discipline as §4.1, one level up.
