# METRICS

Every number usewarden shows you, where it comes from, and what usewarden refuses to guess.

Run `usewarden metrics` for this document applied to your own machine, or `usewarden metrics --json`
for the same thing with every constant included so you can recompute it yourself.

---

## 1. The rule

**A number usewarden displays must be one that neither you nor usewarden can accidentally inflate.**

"Actions blocked" is the figure on the dashboard, in the status line, and in every screenshot
this product would be judged by. That makes it a marketing number, and a marketing number that
cannot be audited is a claim.

Three properties follow, and all three are enforced in code rather than promised:

1. **Derived, never counted.** Every figure is computed by query against the `incidents`,
   `events` and `sessions` tables at the moment you ask. Nothing is read from a running counter.
   A derived number can be recomputed, audited and corrected; a counter can only ever be wrong
   forever.
2. **Grouped by origin.** Every incident carries where it came from — `live`, `demo`, or
   `fixture`. Only `live` reaches a headline. The others are still shown, always under their own
   label.
3. **Checked.** `usewarden metrics` re-runs the arithmetic on every read and names anything
   impossible. A guardian that does not believe its own figures says so, loudly, instead of
   printing them.

### The defect that produced this rule

Before schema v2 the figures came from a `counters` table of free-running integers. Three
consecutive `usewarden demo` runs into a brand-new state directory produced:

```
actions_blocked: 12      <- from zero real agent sessions
catches:         12
events_seen:      8      <- fewer events than blocks
```

Twelve blocks against eight events is not a rounding error; it is a number that cannot exist. It
had two causes, both now fixed and both covered by sabotage tests:

- the demo wrote into the same counters the headline read from (`SAB-17`);
- a duplicate hook delivery — the documented Cursor-replays-Claude-Code case (D-005), or an
  agent's own retry inside the same tick — recorded two incidents while the events table
  deduplicated the pair down to one (`SAB-18`).

The raw artifact is kept at `verification/metrics-inflation-before.txt`, and the after-state at
`verification/metrics-inflation-after.txt`.

---

## 2. Origins

| Origin | Written by | Counts toward a headline? |
|---|---|---|
| `live` | the hook path only — a real agent session on your machine | **yes** |
| `demo` | `usewarden demo` | no. Shown separately and labelled on the card |
| `fixture` | tests, the sabotage suite, `judge-check`, anything hand-fed to the engine | no |

A session is stamped with the origin of the event that created it, and the stamp is **never
upgraded**. A session that begins as a demo stays a demo for its whole life, so nothing that
starts synthetic can graduate into the live numbers later.

---

## 3. The counters, exactly

Per origin:

| Figure | Definition |
|---|---|
| `attempts` | incidents whose action was `block`. **Retries count.** |
| `distinct_actions` | distinct `(rule, tool, target)` triples blocked. **Retries collapse.** |
| `drift_warnings` | Layer-2 findings. Always warnings — Layer 2 never blocks. |
| `advisories` | non-blocking guidance, e.g. context-fill advice |
| `incidents` | every incident row of this origin, whatever its severity |
| `sessions` | sessions of this origin |
| `events` | events inspected, after replay deduplication |

**Why both `attempts` and `distinct_actions`?** An agent that retries the same forbidden `.env`
read five times made five attempts against one distinct action. Both are true; they answer
different questions. "How often did usewarden have to intervene" is `attempts`. "How many
distinct bad things did it stop" is `distinct_actions`, and that is the one that belongs on a
slide. The savings estimate below uses `distinct_actions` only.

### Deduplication windows

Two separate 2-second buckets, both keyed on the session:

- **events** — `(sessionId, event, tool, target, 2s bucket)`. Deliberately excludes the agent id,
  because Cursor may replay a Claude Code hook for the same logical call (D-005).
- **incidents** — `(origin, sessionId, layer, rule, action, tool, target, 2s bucket)`.

Two seconds collapses a duplicate *delivery* while leaving a genuine repeat attempt seconds later
counted as the separate attempt it is.

---

## 4. Estimated savings

> **This is an estimate built from stated assumptions. It is not a measurement, and usewarden
> never displays it as a single number.**

Spec §3.6 requires an estimate of tokens and dollars saved with "estimation method documented
honestly — no invented precision". This section is that method.

### 4.1 What is counted

Only **distinct blocked actions and drift findings in real (`live`) agent sessions.**

- Demo runs are excluded: they did not save anything, because nothing was going to happen.
- Repeat attempts are excluded: blocking the same forbidden read five times did not save five
  recoveries.

### 4.2 What is deliberately *not* priced

| Category | Priced? | Why |
|---|---|---|
| `out_of_scope_write` | yes | the counterfactual really is wasted agent work plus a revert |
| `destructive` | yes | `rm -rf`, `git reset --hard`, force-push to a protected branch — recovery is real work |
| `drift` | yes | work done against the wrong goal is work thrown away |
| `credential_exposure` | **no** | a dollar figure for "your API key did not leak" is invented precision of the worst kind |
| `shell_execution` | **no** | `curl \| sh` and `sudo` are security outcomes, not token outcomes |
| `other` | **no** | an unrecognised rule id means unknown, and unknown means unpriced |

Unpriced catches are **counted and named** in `usewarden metrics`, never converted. The refusal
is the honest part: a tool that turned "we stopped an exfiltration" into "$0.04" would be telling
you less than it knows, not more.

### 4.3 The constants

All three are assumptions. `usewarden metrics --json` prints them so you can substitute your own.

**Marginal tokens per agent tool-call turn** — what the agent generates plus the tool result it
reads back. Not the whole resent context.

```
TURN_TOKENS = { low: 1,000   high: 4,000 }
```

**Turns wasted per blocked action**, low to high:

| Category | low | high | reasoning |
|---|---|---|---|
| `out_of_scope_write` | 1 | 3 | at minimum one turn to notice and revert; at worst notice, revert, and re-explain |
| `destructive` | 2 | 10 | recovery from a reflog or a backup, plus re-establishing where the work had got to |
| `drift` | 2 | 15 | the high bound is **one Layer-2 trigger window**: `judge.every_n_events` defaults to 15, so by construction that is the longest a drift can run before usewarden's own sampled judge would have looked at it anyway |

The `drift` high bound is the only one tied to a real product constant rather than judgement.
The other two are judgement, and are stated as such.

### 4.4 The price

```
reference model : claude-sonnet-5
input           : $2.00 / MTok
output          : $10.00 / MTok
input share     : 0.8
blended         : 0.8 x 2.00 + 0.2 x 10.00 = $3.60 / MTok
checked         : 2026-08-20
source          : https://platform.claude.com/docs/en/about-claude/pricing
```

`input share` is the assumption that agent turns are input-heavy: the full context is resent
every turn while the model writes comparatively little.

Two caveats usewarden prints every time:

- **Your model and rate will differ.** The reference model is a common coding-agent default, not
  a claim about what you run.
- **If your agent runs on a subscription plan, this is quota, not dollars.**

The same staleness discipline as the judge ledger applies: the price carries the date it was last
checked against the vendor's published page, so a figure that has quietly drifted is visible
rather than silent.

### 4.5 The formula

```
for each DISTINCT live blocked action or drift finding:
    category = categorise(rule, layer)
    if category is unpriced: unpriced_actions += 1; continue
    tokens.low  += TURNS_WASTED[category].low  * TURN_TOKENS.low
    tokens.high += TURNS_WASTED[category].high * TURN_TOKENS.high

usd.low  = tokens.low  / 1e6 * 3.60
usd.high = tokens.high / 1e6 * 3.60
```

The band is wide on purpose. **The width is the honesty.** A narrow band here would be a lie
about how well anyone can know this.

### 4.6 What would make this a measurement

`savings.measured` is `false` and stays `false` until all three of these hold:

1. usewarden reads real token accounting from the agent's own transcript, rather than assuming a
   per-turn figure;
2. a counterfactual is observed rather than assumed — e.g. an A/B where the same task runs with
   and without usewarden and the difference in billed tokens is recorded;
3. the price is read from the user's actual provider and plan rather than a reference rate.

None of those are in v1. Until they are, the number is labelled `est.` on every surface, and
`METHOD` (`distinct-live-blocked-actions/v1`) is stamped on it so an old figure can never be
mistaken for a new one. Changing any constant above changes that string.

---

## 5. Guardian overhead

Shown beside the savings, never subtracted from them behind your back:

| Figure | Meaning |
|---|---|
| `metered_usd` | what usewarden's own Layer-2 judge calls cost, at exact recorded token counts |
| `unmetered_calls` | judge calls routed through a local agent CLI. These cost real subscription quota but yield no token counts, so usewarden reports a **count** and never invents a dollar figure |
| `mocked_calls` | judge calls that were mocked and cost nothing |

Token counts in the judge ledger are always exact. Only the USD column is an estimate, and only
because a price can go stale.

---

## 6. The integrity check

`usewarden metrics` re-derives the arithmetic and fails on anything impossible:

- more blocked attempts than inspected events, in any origin — usewarden cannot block what it
  never saw. *(This is exactly the pre-v2 defect.)*
- more distinct actions than total attempts
- an incident total smaller than its own parts
- a savings low estimate above its high estimate
- a savings estimate drawing on more actions than there are live catches

A failure prints in red on `usewarden status`, sets a non-zero exit on `usewarden metrics`, and
fails `usewarden doctor`. Reporting suspect numbers quietly would be a worse failure than
reporting none.

---

## 7. Anti-inflation, as a table

| Attack or accident | Control | Proving test |
|---|---|---|
| `usewarden demo` inflates the headline | origin axis; demo never reaches a live figure | SAB-17 |
| a replayed hook delivery double-counts | incident dedupe hash, 2s bucket | SAB-18 |
| an agent retrying the same action looks like many catches | `distinct_actions` reported alongside `attempts` | SAB-19 |
| the counters table is edited directly | figures are derived by query; counters are debug-only | SAB-20 |
| a crafted rule id smuggles data into telemetry | `isSafeLabel`, plus a cap on distinct rule keys | SAB-21 |
| a demo figure leaves the machine via telemetry | payload built from live-origin metrics only | T-15 |
| savings inflated by repeat attempts or demo runs | distinct live actions only | SAB-24 |
| a consent receipt is forged or outlives its schema | digest-bound receipt, schema-version gate | SAB-23 |

---

## 8. Telemetry

None of the above leaves your machine. Telemetry is off by default, requires a recorded consent
receipt naming the exact schema, and v1 ships no endpoint at all. See `docs/TELEMETRY.md`.
