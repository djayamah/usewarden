# corpus-labels/

The frozen label set behind every precision figure in `docs/PRECISION.md`.

**Almost everything in this directory is deliberately NOT committed.** `blocks-2026-09-08.json`
names real commands and real paths from real agent sessions on the author's machine, and
`policy-baseline.yaml` names the private directories that machine's policy protects. Same reason
`/corpus-backup/` is ignored.

Two files ARE committed, and both are 64 hex characters that leak nothing:

| File | What it pins |
|---|---|
| `FROZEN.sha256` line 1 | the label set — the labels AND the criterion text they were written under |
| `FROZEN.sha256` line 2 | `policy-baseline.yaml`, the ruleset in force when the corpus was recorded |

**The two lines are hashed differently, and `shasum -c` only works on the second.** Line 2 is an
ordinary sha256 of the file's bytes. Line 1 is a hash of the label set's *canonical form* — fields
in a fixed order, labels sorted by id — because key order and indentation in JSON are decisions made
by whoever last wrote the file, and a byte hash would break when a re-serialisation changed neither
a label nor the criterion. Verify line 1 with `usewarden replay --labels`, which recomputes the
canonical form; `shasum -c` will report it FAILED, correctly.

Committing them is the whole point: a relabelling after tuning began, or a quiet swap of the
baseline policy for a friendlier one, shows up as a one-line diff in this repository's history
instead of happening silently.

## Reproducing a measurement

```bash
USEWARDEN_HOME=<dir containing the corpus db> \
  usewarden replay --origin live \
    --labels corpus-labels/blocks-2026-09-08.json \
    --policy corpus-labels/policy-baseline.yaml
```

`replay` recomputes the label-set hash and **refuses to report a number** if it does not match
line 1. It also re-hashes every labelled action against the corpus, so the set cannot be pointed
at a different database.

## Why the policy is pinned too

The corpus spans two policy eras: `~/.usewarden/usewarden.yaml` was rewritten on 2026-08-29,
moving one directory out of `forbidden_paths` and into `allowed_paths`. Replaying against the
LATER file silently drops 18 genuine catches and returns a precision figure barely different from
the baseline — a coverage regression dressed as a null result.

**"The operator edited it" is what this paragraph said until 2026-09-08, and it was wrong.** The
edit was made by an AGENT, from Bash, with `sed -i`, at 05:23:51Z — event 8978 in the record. The
operator had asked for a narrower change; the `sed` went beyond it and also moved `~/dev/…-app`
out of `forbidden_paths`, which is where 17 of the 18 lost catches come from. The agent had already
been refused a `Write` to that same file, twice (incidents 97 and 105). The evidence is in
`verification/policy-drift-2026-08-29/`. The correction matters because attributing it to the
operator makes it read as a considered human decision, and the difference between those two
sentences is the whole reason `usewarden policy --drift` now exists.

So the baseline policy is pinned, and every measurement in `docs/PRECISION.md` holds it fixed and
varies only the engine. Otherwise a tuning run would be taking credit for a coverage regression it
did not cause.
