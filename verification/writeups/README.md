# The identity scans for the 2026-08-26 run

## What was scanned, and what each result means

| File | What it is | Result |
|---|---|---|
| `01-identity-scan.txt` | the two new write-up drafts and `SCHEDULE.md` | **CLEAN** |
| `02-scan-all-touched.txt` | every one of the 32 files this run created or changed | 18 findings, all triaged below |

**The two scans exist separately on purpose, and the second one is the useful one.**

`scripts/scan-text-for-publication.sh` was built for text that is **pasted directly** onto a public
surface — a Discussion, a Discussion comment, a Release body. That text never passes through
`scripts/sanitise-for-publication.sh`, so it has to be clean *as written*. Pointed at the two new
drafts, it is.

The founder's standing instruction is the reason for the second run: *every identity leak in this
project was found because a scan was aimed at what we were about to ship and not at what we already
had.* That held again. The drafts were clean; the run's own **verification transcripts** were not.

## What the second scan found, and what happened to each

**Fixed by construction, not by remembering** (CLAUDE.md §2 corollary):

| Finding | Where it came from | Fix |
|---|---|---|
| absolute home paths, `.local` hostname, and an **email address** | `verification/false-positive-audit/01-classification.txt` — it prints REAL stored commands, one of which was a `git commit` carrying an author address | `scripts/classify-incidents.mjs` now scrubs, reading the identity literals from the same untracked `scripts/scan-identity.txt` the scanner uses, **plus the same four derived literals** the scanner adds. The first attempt read only the file's four and left nine findings, which is precisely the drift the shared-list design exists to prevent. |
| operator identity + home path | `verification/native-comparison/01-what-fires.txt` — a block reason quotes the resolved allowed path | `scripts/probe-native-gap.mjs` scrubs its own output |
| account, host and full path | `verification/corpus-backup/03-restore-proof.txt` — restic's own restore line names all three | `scripts/verify-corpus-backup.sh` pipes restic output through a scrubber |
| home path in a receipt | `verification/corpus-backup/02-snapshot.txt` | `usewarden backup` now renders its File row through `displayPath`, like every other card the product prints. The JSON output keeps the real path, because that one is for a machine. |

**Excluded from publication instead** (D-254):

- `ops/DOGFOOD.md` — a report about the operator's own machine, which says so in its own first
  line. It names their private notes directory, quotes what an agent tried to read out of it, and
  lists which of their agent configs hold usewarden's hooks. It was **not** on `public/main` only
  because the last full publish predates it; nothing excluded it, so the next publish would have
  shipped it. Now in `scripts/internal-only-paths.txt`. Same class as `backups/` (D-244).

**Not a leak — the residue this scan is expected to report:**

- `DECISIONS.md` (5 findings) is published through the **sanitised** tree, not pasted directly, so
  the pre-sanitisation scanner is asking a stricter question than the publication path answers.
  Checked rather than assumed: `git show public/main:DECISIONS.md | grep -c` the flagged address
  returns **0**. The authoritative gate for anything that ships as a commit is
  `./scripts/publish-rehearsal.sh`, which builds the tree the sanitiser produces and scans that.
- `README.md:670` — `allowed_paths: ["/Users/you/dev/your-project"]`, a documentation placeholder.
- `README.md:559` — a URL ending `...-risk-of-burnout`, in which `sk-of-bur` matches the
  credential-shaped-token class. Both are scanner false positives on obviously public text, and
  both predate this run.
- `ops/DOGFOOD.md` (2 findings) — expected, and now moot: the file is internal-only, and the text
  scanner takes a file list rather than consulting that list.

## Reproducing

```bash
./scripts/scan-text-for-publication.sh launch/writeups/*.md          # what gets pasted
./scripts/scan-text-for-publication.sh verification/**/*.txt         # what we already had
./scripts/publish-rehearsal.sh                                       # what a commit would ship
```
