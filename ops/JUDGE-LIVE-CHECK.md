# Live judge check — the ten minutes only you can do

Layer 2 has been proved two ways already, and neither of them is this one.

| What was proved | How | Where |
|---|---|---|
| The rules and the fail-open behaviour | 40 contract tests against each vendor's published request/response schema, transport stubbed, no key | `tests/judge-providers.test.ts` |
| That the judge really catches drift in a real agent session | 12 live sessions, `claude -p` as the judge | `verification/live/04-invariant-drift.txt`, `05-dependency-drift.txt` |
| **That a metered provider still speaks the protocol today** | **nothing yet — this document** | — |

A contract test proves usewarden holds up its end. It cannot prove the vendor still holds up
theirs: an API version bump, a renamed usage field, a retired model id, or a changed pricing page
all look identical to a passing test suite. Until you run the commands below, the three metered
providers are marked **UNVERIFIED-LIVE** in the README and in `docs/HOOK-MATRIX.md`, and they
should stay that way.

**Nothing here needs a key from anyone but you, and no key is ever written to a file, a log, or a
commit.** Every command reads the key from your shell environment and usewarden never prints it —
there is a test that asserts the key cannot appear in a warning (`tests/judge-providers.test.ts`,
"the API key must never appear in a warning").

---

## Before you start (30 seconds)

```bash
cd ~/dev/warden
npm run build
export USEWARDEN_JUDGE_MAX_USD=0.25      # a hard ceiling; each check below costs well under $0.01
export USEWARDEN_JUDGE_NO_LOCAL=1        # force the metered path, not the local CLI on your PATH
```

`USEWARDEN_JUDGE_NO_LOCAL=1` matters. Without it usewarden prefers an authenticated `claude` or
`gemini` on your PATH, and you would verify the provider you already know works.

---

## 1. Anthropic (2 minutes)

```bash
export ANTHROPIC_API_KEY='<paste your key>'   # never commit, never echo
node dist/src/cli.js judge-check
unset ANTHROPIC_API_KEY
```

**PASS looks like exactly this** — five things, all of which must be true:

```
  provider   anthropic / claude-haiku-4-5
  latency    900 ms
  tokens     in 512, out 41
  cost       $0.000717   ledger moved by $0.000717

  ✓ the call completed
  ✓ drift was detected on a scenario that is unambiguously drift
  ✓ the ledger recorded the usage

  verdict    Usewarden (drift judge, confidence 0.90): writing marketing copy is unrelated to
             fixing a failing unit test

  PASS
```

1. `provider` says `anthropic`, not `local-claude`. If it says `local-claude`, `USEWARDEN_JUDGE_NO_LOCAL=1` did not get exported.
2. `tokens` are **non-zero on both sides**. A zero here means the usage field was renamed and the ledger is silently under-counting.
3. `ledger moved by` equals `cost`. If they differ, the accounting path is broken.
4. `drift was detected` is a tick. The scenario is a session whose goal is "fix the failing unit test in src/parser.ts" and whose activity is writing a marketing blog post. A judge that will not call that drift is answering but not working.
5. The last line is `PASS`, and `echo $?` is `0`.

**Anything else is a FAIL, and the output says which of the three it is:**

| Output contains | Meaning | What to do |
|---|---|---|
| `AUTH` … `Retrying will not help` | the key was rejected | check the key; nothing in usewarden is wrong |
| `RATE_LIMIT` | transient | wait a minute and re-run |
| `PROVIDER_DOWN` | the vendor is down or overloaded | re-run later |
| `JUDGE_UNPARSEABLE` | the call worked, the answer was not usable | the model or its JSON mode changed — open an issue with the output |
| `tokens in 0, out 0` with a PASS | usage-field drift | fix the parser in `src/engine/judge.ts`, add a case to the contract suite |
| `JUDGE_PRICING_STALE` | the prices are >120 days old | re-check the source URL and update `pricedOn` |

---

## 2. OpenAI (2 minutes)

```bash
export OPENAI_API_KEY='<paste your key>'
node dist/src/cli.js judge-check
unset OPENAI_API_KEY
```

Same five checks. `provider` must read `openai / gpt-5-mini`.

One provider-specific thing to watch: current OpenAI models reject the legacy `max_tokens` field
and require `max_completion_tokens`. If you see `REQUEST_REJECTED` mentioning either name, that
is the field having moved again — the contract suite has a test named "the legacy max_tokens
field must not be sent" that will need updating with it.

---

## 3. Gemini (2 minutes)

```bash
export GEMINI_API_KEY='<paste your key>'
node dist/src/cli.js judge-check
unset GEMINI_API_KEY
```

Same five checks. `provider` must read `gemini / gemini-3.7-flash`.

Gemini-specific: a `REQUEST_REJECTED` naming the model usually means the model id has rolled
forward (`gemini-2.5-flash` → `gemini-3.7-flash` already happened once). The id lives in
`PROVIDERS` in `src/engine/judge.ts` and is overridable per-repo with `judge.model` in
`usewarden.yaml`, so you can confirm a new id without editing code:

```bash
GEMINI_API_KEY='<key>' node dist/src/cli.js judge-check --json | python3 -m json.tool
```

---

## 4. Record the result (2 minutes)

```bash
# ~30 seconds, and it is the artifact that lets the README stop saying UNVERIFIED-LIVE
for p in anthropic openai gemini; do echo "$p: <PASS|FAIL> $(date -u +%F)"; done \
  > verification/judge-live-check.txt
```

Then edit two files to replace **UNVERIFIED-LIVE** with **verified YYYY-MM-DD** for each provider
that passed:

- `README.md` — the "Layer 2 providers" table
- `docs/HOOK-MATRIX.md` — the "Layer 2 judge providers" table

Leave any provider you did not test as UNVERIFIED-LIVE. A row that says "verified" because the
other two passed is exactly the kind of claim this project keeps refusing to make.

---

## Total cost and total time

Three calls, roughly 500 input and 50 output tokens each. At the prices recorded in
`src/engine/judge.ts` on 2026-08-19 that is under **$0.002 for all three**, and
`USEWARDEN_JUDGE_MAX_USD=0.25` is a hard stop well below anything that could surprise you.

Wall-clock: **under ten minutes**, most of it pasting keys.
