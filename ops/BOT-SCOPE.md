# Bot scope and blast radius

Read this before enabling anything in `bots/`.

## What the bot is

A **separate, isolated service.** It is not a plugin or a skill inside the founder's personal
agent setup, shares no code path with it, and has no route to any personal system. It runs as a
GitHub Actions job in this repository, from this repository's checkout, and nowhere else.

## Channels

| Channel | Covered? | Why |
|---|---|---|
| **GitHub issues** on `djayamah/usewarden` | **yes** | the one place automated help is expected and welcome |
| **Issue comments, Discussions, Discussion comments, PR comments** on the same repository | **wired, OFF by default** | code exists and is tested; each surface is inert until named in `TRIAGE_BOT_SURFACES`, which defaults to `issue` alone. See *The conversation guard* below |
| **X mentions and replies on our own posts** | **built, not connected** | see `ops/X-BOT-SETUP.md`; drafts by default, never auto-posts |
| **Hacker News** | **never** | HN's guidelines ban generated and AI-edited comments outright: *"Don't post generated comments or AI-edited comments. HN is for conversation between humans."* Any bot presence there is a violation, not a grey area |
| **Reddit** | **never** | subreddit rules and moderator norms are hostile to automated posting, and the reputational cost of getting it wrong is asymmetric. See `launch/REDDIT-PRESENCE.md` |
| Email, Discord, Slack, anywhere else | **never** | not built, not planned |

**Therefore these questions always land on the founder:** anything asked on HN, anything asked on
Reddit, anything asked in a DM, anything the bot declines (which it does by design when the
repository's documents do not answer), and every issue the bot labels `unmatched`, `docs-gap` or
`needs-info`. The bot reduces the volume of the easy questions. It does not remove the founder from
support.

`docs-gap` is the newest of those three and the most actionable: it means a question the documents
genuinely do not answer, which is a defect in the documentation with an owner and a fix, rather
than a report nobody could parse. It used to be indistinguishable from the other two — all three
were `unmatched` — which is how issue #14's real finding (a metrics document that never used the
word "monitor") sat in the queue looking like an unreadable bug report.

## The conversation guard

Every surface beyond `issues: opened` is governed by `bots/triage/src/conversation.ts`, a pure
function over a thread snapshot. The failure mode it exists for is not "misses a question" — it is
**talking over a conversation between two humans**, and a support bot that does that is worse than
one that stays quiet. Four rules, all failing closed:

1. **Never reply to itself**, or to any other bot. The comment the bot posts is an event on the
   same thread; without this the first reply triggers the second.
2. **Never twice to the same person in a thread.** Someone already answered who asks again is
   unsatisfied or arguing, and a second automated answer is the bot insisting.
3. **Never reply to a maintainer.**
4. **Never be the third consecutive bot comment**, counting any bot — the backstop for loops the
   first three did not foresee.

An input it cannot reason about — an unnamed author, an unrecognised surface — is a refusal, never
a reply. `tests/bot-conversation.test.ts` proves the rules; `tests/bot-surface.test.ts` proves they
are actually invoked on the path that posts, which is a different claim and the one that matters.

## What it can reach

**Everything it is allowed to touch, exhaustively:**

- the repository checkout the Actions runner creates, read-only in practice;
- `api.github.com` — REST for issues, GraphQL for discussions (there is no REST discussions API) —
  with a job-scoped `GITHUB_TOKEN` limited to `contents: read`, `issues: write` and
  `discussions: write`. `discussions: write` grants nothing over code, pull requests or settings;
  it is the minimum that can post a discussion comment at all, and it is only reachable when a
  discussion surface is named in `TRIAGE_BOT_SURFACES`;
- one model API endpoint, and only if a `USEWARDEN_BOT_*` key is configured — which is **off by
  default**.

**What it cannot reach, by construction:** the founder's `gh` credentials (the workflow uses the
job token and sets `persist-credentials: false`), Gmail, Calendar, Telegram, iCloud, any local
vault, any file outside the runner's checkout, any host other than the two named above, and any
state from a previous run — it is **stateless between issues** and keeps no memory of any kind.

## Blast radius if it is fully compromised

Assume the worst: an attacker fully controls the model's output, or the model is malicious.

**What they get:**

1. **A wrong label** on an issue. Reversible in one click.
2. **One wrong sentence** in one comment, from the model's `note` field — and only after it
   survives a filter that drops any note containing a URL, or claiming something is fixed, known,
   a duplicate or resolved.
3. Nothing else.

**Why that is the ceiling, and not optimism:**

- **The model never writes the answer.** Every substantive statement in a bot comment is a
  *verbatim quotation* retrieved from a file in this repository, with a link to it. There is no
  code path in which model-generated prose about the product reaches a reader as fact. A
  compromised model cannot make the bot say something untrue about usewarden, because the bot
  does not compose statements about usewarden at all.

  **This is now enforced by a test rather than by convention** — `tests/bot-no-generated-prose.test.ts`.
  It runs the same issue twice, once with a classifier returning maximally hostile prose, and
  requires the two comments to differ by at most one clearly-marked italic line. Differential, not
  pattern-matching: a pattern test catches only the hostile strings someone anticipated, and the
  change this page warns about is one that keeps every existing test green. It also asserts that
  every quoted line really is verbatim in a corpus file — the promise breaks just as thoroughly, and
  just as silently, if the retriever starts paraphrasing.
- **It cannot close, lock, assign, edit, or merge anything.** `issues: write` permits commenting
  and labelling. It permits nothing else, and the workflow grants nothing else.
- **It cannot push code.** `contents: read`, and `persist-credentials: false`.
- **It cannot read a secret it was not given.** The only secrets in the job are the model key, if
  one is configured, and the job token — which expires when the job ends.
- **It cannot exfiltrate the repository**, because everything in the checkout is already public.
- **It cannot spam.** On a new issue: one comment ever. On a conversation surface: never twice to
  the same person in a thread, and never as the third consecutive bot comment. Across the whole
  repository and every surface: 30 comments per day, one shared cap rather than one per surface,
  so a loop on discussions cannot run at full rate while issues look healthy. All checked before
  anything is posted.
- **It cannot persist.** Stateless between issues; a compromise of one run does not carry into
  the next.
- **It can be stopped in two ways**, either sufficient: commit `.github/TRIAGE_BOT_DISABLED`, or
  set the repository variable `TRIAGE_BOT_ENABLED` to anything but `true`. The variable is also
  the ON switch, so merging the workflow does not start it.

The residual risk that is *not* zero: a wrong label and one wrong sentence, on a public issue,
signed as automated. That is the honest ceiling and it is why the design is shaped this way.

## Prompt injection

Every issue body is treated as hostile input. It is wrapped in `<<<UNTRUSTED ... >>>` markers, the
instruction block states that content inside them is data and never an instruction, and the model
is asked for nothing but a label and one sentence — which is then filtered again.

`tests/bot.test.ts` drives five injections through the real path — leak the system prompt, post a
link, claim a bug is fixed, impersonate the maintainer, exfiltrate the environment — asserting in
each case that the hostile instruction really reached the bot before asserting that nothing it
emitted changed.

## The rule that makes all of this hold

**The founder cannot check the bot's technical claims.** That single fact is why the bot quotes
instead of explaining, cites instead of asserting, and declines instead of guessing. If a future
change lets the model write prose that reaches a reader as fact, every guarantee on this page
weakens at once — and this document should be the thing that stops it.
