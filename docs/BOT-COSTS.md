# What the support bot costs to run

The bot's bill is the maintainer's, not the user's. This is what it costs, at every scale worth
planning for, with every assumption stated.

## The short version

**With no model key configured — the default — the bot costs nothing.** It is entirely
deterministic: retrieval over this repository's own documents, plus regex matching against the
recorded defect history. GitHub Actions minutes on a public repository are free. That is the
supported configuration, and it is the one that ships.

A model key is optional and buys one thing: a label suggestion for issues the deterministic pass
could not place. It never writes an answer.

## Provider selection

Same policy as the Layer 2 judge, for the same reason: **cheapest-capable, computed from the price
table** rather than a hand-written order. Re-check a price and the ordering corrects itself.
Prices checked 2026-08-20 against each vendor's published page.

| Rank | Provider | Model | $/MTok in | $/MTok out | Per classification |
|---|---|---|---|---|---|
| 1 | OpenAI | `gpt-5-mini` | $0.25 | $2.00 | ~$0.000295 |
| 2 | Gemini | `gemini-3.7-flash` | $0.75 | $3.75 | ~$0.000750 |
| 3 | Anthropic | `claude-haiku-4-5` | $1.00 | $5.00 | ~$0.001000 |

One classification is ~700 input tokens (the fixed instruction block plus a truncated issue body)
and ~60 output tokens (a small JSON object). Measured against the actual prompt, not estimated.

The bot reads `USEWARDEN_BOT_OPENAI_KEY`, `USEWARDEN_BOT_GEMINI_KEY`,
`USEWARDEN_BOT_ANTHROPIC_KEY` — deliberately **not** the standard `ANTHROPIC_API_KEY` family, so
a key placed in CI for the bot cannot be picked up by anything else that reads the usual names.

## Worst-case monthly cost

The model only runs on issues the deterministic pass could not match. In the eval set that is a
minority, but the table below assumes **every issue** needs one, which is the worst case:

| Issues / month | Classifications | Cost at rank 1 | Cost at rank 3 (dearest) |
|---|---|---|---|
| 10 | 10 | **$0.003** | $0.01 |
| 100 | 100 | **$0.03** | $0.10 |
| 500 | 500 | **$0.15** | $0.50 |

**At 500 issues a month the dearest provider costs fifty cents.** The honest summary is that the
model is not a cost consideration at any plausible scale for this project; it is a *correctness*
consideration, which is why it is limited to labelling and why the default is off.

GitHub Actions minutes are free for public repositories. Each run is one checkout, one `npm ci
--ignore-scripts`, one build, and one short script — under two minutes.

## What bounds it

- **One comment per issue, ever.** The bot checks for its own prior comment before posting.
- **A daily cap of 30 comments across the repository.** A broken trigger or a bulk issue import
  cannot turn into thirty notifications and thirty classifications.
- **A kill switch in two forms**, either sufficient: a committed file at
  `.github/TRIAGE_BOT_DISABLED`, or the repository variable `TRIAGE_BOT_ENABLED` set to anything
  other than `true`. The variable is also the ON switch — merging the workflow does not start it.
- **A 20-second timeout and zero retries** on the model call. A provider outage costs nothing and
  never blocks the deterministic comment.

## If the model is ever asked to do more

It should not be, and the reason is in `ops/BOT-SCOPE.md`: every substantive statement the bot
makes is a verbatim quotation from a file in this repository. If that ever changes, this document
and the cost model change with it — and so does the risk, which is the part that actually matters.
