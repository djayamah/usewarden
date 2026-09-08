# GitHub discovery — audited 2026-08-22

**Every GitHub-side surface that decides whether a stranger can find this project, measured
against what `launch/DISCOVERABILITY.md` says we did.**

Run the audit yourself — it is read-only and takes a second:

```bash
./scripts/verify-discovery.sh
```

---

## What is already correct, and now checked rather than assumed

| Surface | State | Checked by |
|---|---|---|
| GitHub topics | 10, **exactly** the documented set | `verify-discovery.sh` |
| npm keywords | 20, **exactly** the documented set | `verify-discovery.sh` |
| Repository description | set, 220 chars, free of the rejected `firewall` claim | `verify-discovery.sh` |
| Issues | enabled, with three templates | — |
| Discussions | **enabled**, six default categories, `q-a` answerable | — |
| Licence | MIT, detected by GitHub | — |
| Security policy | present; private vulnerability reporting on | — |

The first three were correct before this audit. That is worth saying plainly: the work was already
done, and what was missing was anything that would notice if it stopped being true. Topics and
keywords are edited in a web UI, never appear in a diff, and cost nothing to get wrong until the
day they matter. `scripts/verify-discovery.sh` closes that, and it is sabotage-proven — planting a
topic in the document that the repository does not carry makes it exit 1 and name the topic.

## The gaps, and who can close them

### 1. No custom social preview image — founder only

`usesCustomOpenGraphImage` is `false`, so **every link to this repository, anywhere, renders
GitHub's generated grey card**: owner, name, and the description in small type. That is the asset
that appears in a Slack unfurl, an X card, a Discord embed, and Google's result snippet.

`assets/incident-card.png` is exactly the image that explains the product without a sentence, and
the README already leads with it for the same reason.

**There is no API for this field.** It is not in the REST repository object, not in GraphQL, and
not settable by `gh`. It is a file upload in **Settings → General → Social preview**, and it is
therefore a manual step rather than an oversight.

Recommended: `assets/incident-card.png`. GitHub's stated ideal is 1280×640; it will letterbox
anything else rather than reject it.

### 2. ~~No releases~~ — **v0.1.0 published 2026-08-24**

<https://github.com/djayamah/usewarden/releases/tag/v0.1.0> — tag `v0.1.0` on
`3503705f78`, not a draft, not a pre-release, `Latest`. Body from
`ops/prepared/release-0.1.0.md`, read back via the API and identical bar the trailing newline
GitHub appends.

Releases are one of the very few things GitHub actively **distributes** rather than merely hosts:
to watchers, into the dashboard feed, and into release-tracking tools. An empty releases tab on a
project whose README describes a shipped product read, correctly, as "this has never shipped".

**It carried one sentence with a shelf life, on purpose:** *"Not installable from npm yet. The
registry still serves the `0.0.0` placeholder."* **That sentence has been removed (2026-08-26).**
`npm view usewarden dist-tags` now reads `latest: 0.1.0`, so the note stopped being true the
moment the staged package was approved and was edited out the same day — a Release body is
editable in place and the URL does not change. The block quote now describes the trusted-publisher
route instead, which does not expire. See `ops/RELEASE-0.1.0.md`.

### 3. `homepage` points at this repository's own README — deferred, deliberately

```
homepage = https://github.com/djayamah/usewarden#readme
```

The About sidebar renders this as its most prominent link, and it currently sends a visitor to the
page they are already reading. A wasted slot rather than a broken one.

**Not changed, and the reason is ordering.** The obviously better target is the npm package page —
but npmjs.com currently serves `usewarden@0.0.0`, a placeholder carrying the description an
adversarial read rejected (D-171). Pointing the repository's front door at that would be worse than
pointing it at itself. Once `0.1.0` is the `latest` version:

```bash
gh api -X PATCH repos/djayamah/usewarden -f homepage=https://www.npmjs.com/package/usewarden
```

Reversible in one command, so it is a decision to make once rather than to agonise over.

### 3b. The bot's wider surface is merged but switched off — one command when you want it

[#16](https://github.com/djayamah/usewarden/pull/16) is merged. The bot can now answer on issue
comments, discussions, discussion comments and PR comments, and answers on **none** of them: it is
inert behind `TRIAGE_BOT_SURFACES`, which is unset and therefore means `issue` alone. Nothing about
the merge changed its behaviour. When you want it:

```bash
gh variable set TRIAGE_BOT_SURFACES --repo djayamah/usewarden \
  --body 'issue,issue_comment,discussion,discussion_comment'
```

`TRIAGE_BOT_ENABLED` is currently `false`, so the bot is off entirely regardless.

### 4. ~~Discussions are enabled but empty~~ — **seeded 2026-08-24**

| # | Category | Title |
|---|---|---|
| [#18](https://github.com/djayamah/usewarden/discussions/18) | `q-a` | Do I need an API key, and does any of this cost money? |
| [#17](https://github.com/djayamah/usewarden/discussions/17) | `show-and-tell` | Your agent hook says it is registered. It has never run. |

An empty Discussions tab is slightly worse than none: it is a room with the lights on and nobody in
it. Both seeds are therefore useful at an audience of zero — #18 answers the question every single
person arrives with, so it works as documentation; #17 is the first of the incident write-ups and
is a debugging technique someone can use tonight with no product involved.

Both were read back via the GraphQL API after posting rather than trusting the mutation, and both
were scanned first (below).

### Publishing the next write-up

Three commands, and the first is not optional. `launch/` is in `internal-only-paths.txt`, so those
files are dropped from the published tree and **have never been seen by any other scan in this
repository** — the category of file least likely to be clean is the one now most likely to be
posted.

```bash
N=08-build-gate-that-skipped-the-build          # the piece due; see launch/writeups/SCHEDULE.md

./scripts/scan-text-for-publication.sh "launch/writeups/$N.md"   # exit 1 = do not post

python3 - "$N" <<'PY'
import sys
src = open(f'launch/writeups/{sys.argv[1]}.md').read().split('\n')
open('/tmp/wu-title.txt','w').write(src[0].lstrip('# ').strip())
open('/tmp/wu-body.md','w').write('\n'.join(src[1:]).lstrip('\n') + """

---

*One of eight write-ups, each about one real defect found while building
[usewarden](https://github.com/djayamah/usewarden) — a local guardrail for AI coding agents. Every
claim is backed by an artifact in that repository. The technique is useful whether or not you ever
use the tool.*
""")
PY

# Look the node IDs up rather than pasting them. See the note below on why.
CAT=show-and-tell     # or q-a
eval "$(gh api graphql -f query='{repository(owner:"djayamah",name:"usewarden"){
    id discussionCategories(first:20){nodes{id slug}}}}' \
  --jq '"REPO_ID=\(.data.repository.id) CAT_ID=\(.data.repository.discussionCategories.nodes[]
        | select(.slug=="'"$CAT"'") | .id)"')"

gh api graphql -F repoId="$REPO_ID" -F catId="$CAT_ID" \
  -F title="$(cat /tmp/wu-title.txt)" -F body="$(cat /tmp/wu-body.md)" \
  -f query='mutation($repoId:ID!,$catId:ID!,$title:String!,$body:String!){
    createDiscussion(input:{repositoryId:$repoId,categoryId:$catId,title:$title,body:$body}){
      discussion{number url}}}'
```

**Why the IDs are looked up and not pasted.** They were pasted, in the first version of this page,
and `gitleaks` flagged the line as a `generic-api-key` — blocking `publish-rehearsal.sh` and
therefore `verify-all.sh`. GitHub's GraphQL node IDs are public, opaque, base64-ish strings, which
is exactly what a secret looks like to a pattern scanner. That is D-160 again, where the public CI
gate could not tell a `DEADBEEF` test fixture from a real key.

**The fix was the document, not the scanner.** Adding an allowlist entry for a "generic-api-key"
finding in an ops file would have widened the rule that catches real keys, permanently, to spare
two lines of convenience — and D-153 is this repository's record of catching itself weakening a
control to make a check pass. Looking the IDs up is better documentation regardless: a reader
should not have to trust that my copy of an opaque identifier is still correct.

**Deliberately not automated:** a scheduled job posting prose to a public surface with nobody
reading it first is the opposite of what the schedule's *Rules for the run* exist to enforce.

**The off-GitHub half of each week is not mine.** The schedule names a personal blog and a
subreddit; §7 exception 2 closes both, and the amendment says so in as many words.

---

## What is deliberately NOT being done

- **No GitHub Pages site.** `site/index.html` exists and is not deployed. Deploying is authorized
  under the amended §3 (cost is the line, not deployment) but it is not a discovery win while
  there is nothing to link to it, and it adds a surface to keep in sync with the README.
- **No topic padding.** Ten is inside GitHub's own five-to-eight-ish convention and each was argued
  for. Adding `ai`, `security`, `cli` back would put the repository on page forty of each, which
  `DISCOVERABILITY.md` already rejected once.
- **No repository-name change.** The coined name is a permanent constraint that the launch copy is
  built around, not a defect to fix.
- **Nothing posted anywhere off this repository.** Exception 2, unamended, and the amendment does
  not touch it either.
