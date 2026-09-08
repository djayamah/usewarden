**Short answer: no, and it does not need one to do the thing it exists to do.**

This comes up first every time, so it is worth having in one place with the exact wording from the documentation rather than a paraphrase.

## Layer 1 — the blocking — needs no key and costs nothing

From [`README.md`](https://github.com/djayamah/usewarden/blob/main/README.md):

> **Layer 1 — deterministic, zero tokens, every single event.** Scope globs, command patterns, protected branches, sibling-repo detection, context-fill threshold. Measured to catch **15 of 17** of usewarden's own sabotage suite on its own, with no model involved.

That is the part that stops an agent writing outside your project, reading `.env`, running `rm -rf`, or force-pushing. It is pattern and scope matching. It makes no API calls, consumes no tokens, and has no network path at all.

## Layer 2 — the drift judge — is optional, and you bring your own key

> **Layer 2 — a sampled LLM drift judge.** Compares what the agent is doing against the goal you declared and the invariants you wrote. Runs on a trigger, not on every call, in a detached process so it never makes your agent wait. It can only ever *warn*.

Three things about it that matter more than the feature itself:

1. **It cannot block.** The ordering is fixed and not configurable: Layer 1 runs first, Layer 2 can only add findings.
2. **It cannot take Layer 1 down with it.** If the judge is unavailable, unaffordable, or returns something unparseable, usewarden says so loudly and carries on blocking.
3. **If you already have a `claude` or `gemini` CLI signed in, it will use that** rather than a metered API key — your existing subscription, no per-call bill.

## So what does it cost?

Nothing. From the FAQ:

> Yes. usewarden is free and open source under the MIT licence, and there is no paid tier, no account, and nothing to sign up for.

The only way to spend money with usewarden is to deliberately point Layer 2 at a paid API with your own key. Leave it unconfigured and it tells you it is unconfigured and keeps blocking.

## Does it send my code anywhere?

No. Telemetry is off by default, and v1 ships **no endpoint at all** — there is nothing for it to send to. Monitoring usewarden means reading your own local database.

---

*If the answer above does not match what you are seeing, that is a bug and I would like the issue. The claims here are quotations from files in this repository, so they can be checked rather than trusted.*
