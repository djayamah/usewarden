## What this changes, and why

<!-- The diff says what. This section is for why. -->

## How it was verified

Tick what you actually ran. An unticked box is fine; a ticked box that was not run is the exact
failure this project exists to catch.

- [ ] `npm test` passes
- [ ] `./scripts/verify-all.sh` exits 0
- [ ] Tested against a **real agent session** in `fixtures/sandbox-project/` — transcript attached
- [ ] Not applicable (docs, comments, or a change that cannot fire at runtime)

<!--
If this touches hook registration or invocation, a live session is not optional. Three of this
project's registration bugs passed every contract test and failed the moment a real agent ran:
a millisecond/second unit mismatch, a dropped `args` array, and an empty stdout being counted as
a hook failure. Each one left `usewarden status` saying PROTECTED while nothing was enforcing.
-->

## Checklist

- [ ] No new runtime dependencies (or: a case is added to `docs/DEPENDENCY-BUDGET.md`)
- [ ] No `preinstall` / `install` / `postinstall` / `prepare` script added
- [ ] No shell invocation added — `execFile` with an argv array only
- [ ] If a rule changed: `launch/RULES-REGISTRY.md` and the sabotage suite are updated
- [ ] If an adapter changed: `docs/HOOK-MATRIX.md` row updated, with an honest verification status
- [ ] If a defect was found by **running** something rather than reading it, the PR says so
