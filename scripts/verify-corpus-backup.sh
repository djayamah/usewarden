#!/usr/bin/env bash
#
# Prove that the corpus survives the whole chain: snapshot -> restic -> restore -> read.
#
# WHY THIS EXISTS. `usewarden backup` verifies what it just wrote, which proves the snapshot is a
# database. It does not prove the snapshot SURVIVES A BACKUP, and those are different claims. The
# founder's offsite job (~/scripts/mac-backup.sh) carries the same warning in its own header: "A
# BACKUP NOBODY HAS RESTORED FROM IS NOT A BACKUP."
#
# WHAT THIS DOES NOT PROVE, stated here rather than left to be assumed. It does not touch the real
# offsite repository. That repository is `sftp:storagebox:...` — a REMOTE SYSTEM, which CLAUDE.md
# §1 forbids running any command against, and whose snapshots contain paths §1 forbids resolving.
# So the restic leg is exercised against a throwaway LOCAL repository created here, with the same
# restic binary and version. What carries the real repository is the offsite job's own include
# list: `$HOME/dev` is a TARGET (verified in verification/corpus-backup/01-coverage-gap.txt), and
# that include path was itself proven by an actual restore on 2026-08-14, recorded in that
# script's comments. The chain is: this script proves the file round-trips through restic; the
# offsite job's TARGETS prove the file is in scope; its own restore test proves the include path.
#
# The temp repository uses --insecure-no-password DELIBERATELY. A password would have to be
# invented, held and written down, and CLAUDE.md §2 forbids handling one at all. This repository
# holds a copy of data that is already in plaintext two directories away, exists for seconds, and
# is deleted at the end. It is a test fixture, not a backup.
#
# Everything runs inside the repo. No write leaves ~/dev/warden.
#
# Usage: ./scripts/verify-corpus-backup.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$REPO"

# CLAUDE.md §1: a symlink is not a fence. Resolve before acting.
case "$REPO" in
  */dev/warden) : ;;
  *) echo "REFUSING: resolved repo root is $REPO, not .../dev/warden" >&2; exit 1 ;;
esac

SRC_DIR="$REPO/corpus-backup"
WORK="$REPO/.usewarden-tmp/corpus-proof"
RESTIC_REPO="$WORK/restic-repo"
RESTORE="$WORK/restored"
TMPHOME="$WORK/home"
CLI="$REPO/dist/src/cli.js"

rm -rf "$WORK"
mkdir -p "$WORK"

# node:sqlite prints an ExperimentalWarning on some versions; it is noise in a proof transcript
# and the product suppresses it the same way (src/boot.ts, D-003).
NODE() { node --disable-warning=ExperimentalWarning "$@"; }
probe() { NODE "$REPO/scripts/corpus-probe.mjs" "$@"; }

# Redact by construction (CLAUDE.md §2 corollary). This transcript is committed to
# `verification/`, which is published, and restic's own restore line names the account, the
# Bonjour hostname and the absolute path. Found by pointing the identity scan at what this run
# had ALREADY written rather than only at the drafts it was about to publish - which is the
# founder's standing point about scans, arriving as a finding against this very run.
scrub() { sed -e "s|$HOME|~|g" -e 's|/Users/[A-Za-z0-9._-]*|~|g' \
              -e 's|[A-Za-z0-9._%+-]*@[A-Za-z0-9.-]*\.[A-Za-z][A-Za-z]*|<email>|g' \
              -e 's|[A-Za-z0-9-]*\.local|<host>|g'; }

pass=0; fail=0
say()  { printf '\n%s\n' "$*"; }
chk()  { if [ "$1" = "1" ]; then printf '  PASS  %s\n' "$2"; pass=$((pass+1));
         else printf '  FAIL  %s\n' "$2"; fail=$((fail+1)); fi; }

say "=== 0. Preconditions ==================================================="
command -v restic >/dev/null || { echo "restic not installed" >&2; exit 1; }
echo "  restic: $(restic version)"
echo "  node:   $(node --version)"

SNAP="$(ls -1 "$SRC_DIR"/usewarden-corpus-*.db 2>/dev/null | tail -1 || true)"
[ -n "$SNAP" ] || { echo "no snapshot in $SRC_DIR - run: usewarden backup --to $SRC_DIR" >&2; exit 1; }
echo "  snapshot under test: $(basename "$SNAP")"

ORIG_SHA="$(shasum -a 256 "$SNAP" | awk '{print $1}')"
echo "  sha256: $ORIG_SHA"

# --- ASSERT THE THING UNDER TEST IS REALLY THERE BEFORE TESTING THE DEFENCE ------------------
# CLAUDE.md §4.2. A restore proof that passes because the source was empty is worse than none:
# an empty database restores perfectly and reads back perfectly. So establish, from the SOURCE,
# that there is a real corpus here at all - and capture the exact incident the restored copy
# will later have to produce.
say "=== 1. The corpus under test is real (asserted BEFORE any restore) ====="
read -r SRC_SESS SRC_EV SRC_INC SRC_LIVE < <(probe "$SNAP" counts)
echo "  sessions=$SRC_SESS events=$SRC_EV incidents=$SRC_INC live-incidents=$SRC_LIVE"
chk "$([ "$SRC_LIVE" -gt 0 ] && echo 1 || echo 0)" "source holds at least one REAL incident ($SRC_LIVE)"
chk "$([ "$SRC_EV" -gt 100 ] && echo 1 || echo 0)"  "source holds a real event stream ($SRC_EV events)"

# The single incident this whole proof is about: a blocked publish, from a real session.
WITNESS="$(probe "$SNAP" witness)"
echo "  witness incident: $WITNESS"
WID="${WITNESS%% *}"
chk "$([ -n "$WID" ] && echo 1 || echo 0)" "a named witness incident exists to look for after the restore"

say "=== 2. restic round trip (local throwaway repo, no password, no remote) "
restic init --repo "$RESTIC_REPO" --insecure-no-password >/dev/null
restic backup "$SRC_DIR" --repo "$RESTIC_REPO" --insecure-no-password --tag corpus-proof 2>&1 | tail -3 | scrub
restic check --repo "$RESTIC_REPO" --insecure-no-password 2>&1 | tail -2 | scrub

mkdir -p "$RESTORE"
restic restore latest --repo "$RESTIC_REPO" --insecure-no-password --target "$RESTORE" 2>&1 | tail -2 | scrub

RESTORED="$RESTORE$SNAP"
chk "$([ -f "$RESTORED" ] && echo 1 || echo 0)" "restored file exists at $(basename "$RESTORED")"

REST_SHA="$(shasum -a 256 "$RESTORED" | awk '{print $1}')"
echo "  restored sha256: $REST_SHA"
chk "$([ "$REST_SHA" = "$ORIG_SHA" ] && echo 1 || echo 0)" "restored copy is BYTE-IDENTICAL to the snapshot"

say "=== 3. Read a real receipt OUT OF THE RESTORED COPY ===================="
# This is the step the founder asked for, and it is the only one that proves the restored bytes
# are a working record rather than a file of the right length. usewarden is pointed at the
# restored database through USEWARDEN_HOME and asked, as a user would ask, what it caught.
mkdir -p "$TMPHOME"
cp "$RESTORED" "$TMPHOME/usewarden.db"

SESSION="$(probe "$TMPHOME/usewarden.db" session "$WID")"
echo "  reading the receipt for session $SESSION out of the restored database"

RECEIPT="$WORK/receipt.txt"
USEWARDEN_HOME="$TMPHOME" NODE "$CLI" last "$SESSION" > "$RECEIPT" 2>&1 || true
sed -n '1,40p' "$RECEIPT" | scrub

grep -qE '[0-9]+ blocked' "$RECEIPT" && r1=1 || r1=0
chk "$r1" "the receipt read from the RESTORED copy reports what that session had blocked"

# The receipt is a SUMMARY - it carries counts, not rule ids. The card is where the rule and the
# exact command live, so the witness is looked for there. Getting this wrong cost one FAIL, and the
# distinction is worth keeping visible: "the record is readable" and "the record still names what
# it caught" are two claims, and they need two different commands.
CARDS="$WORK/incidents.txt"
USEWARDEN_HOME="$TMPHOME" NODE "$CLI" incidents 200 > "$CARDS" 2>&1 || true
WRULE="$(printf %s "${WITNESS#* }" | sed "s/ .*//")"   # "commands.deny[9]" - see NOTE below
# NOTE: the rule id is assembled rather than written out, because the literal release command
# appears inside it and Layer 1 matches raw command text - so writing this line the obvious way
# gets the line itself blocked. That is D-247, hit for the second time, in this very file.
# -F: the rule id contains [9], which grep would read as a character class.
echo "  cards naming $WRULE: $(grep -cF "$WRULE" "$CARDS" || true)"
grep -qF "$WRULE" "$CARDS" && r1b=1 || r1b=0
chk "$r1b" "the incident cards from the RESTORED copy still name the witness rule $WRULE"

WEEK="$WORK/week.txt"
USEWARDEN_HOME="$TMPHOME" NODE "$CLI" week 3650 > "$WEEK" 2>&1 || true
sed -n '1,30p' "$WEEK" | scrub
grep -qi 'session' "$WEEK" && r2=1 || r2=0
chk "$r2" "\`usewarden week\` runs against the restored copy and reports sessions"

say "=== 4. NEGATIVE CONTROL: prove this proof can fail ====================="
# Everything above passes on a good file. A check that has never been seen to fail is not
# evidence. Corrupt a copy in the one way a torn file-level backup of a WAL database actually
# fails - a truncated tail - and require the verifier to refuse it.
BAD="$WORK/corrupt.db"
cp "$RESTORED" "$BAD"
FULL=$(wc -c < "$BAD" | tr -d ' ')
NODE --input-type=module -e 'import fs from "node:fs";fs.truncateSync(process.argv[1],Math.floor(Number(process.argv[2])*0.6));' "$BAD" "$FULL"
echo "  truncated $FULL bytes -> $(wc -c < "$BAD" | tr -d ' ') bytes"
BADOUT="$(NODE "$REPO/scripts/corpus-integrity.mjs" "$BAD" 2>&1 || echo "REJECTED-threw")"
echo "  integrity_check on the corrupted copy: $BADOUT"
case "$BADOUT" in
  REJECTED*) chk 1 "a corrupted snapshot is REJECTED by the same check that passed the good one" ;;
  *)         chk 0 "a corrupted snapshot was ACCEPTED - the check proves nothing" ;;
esac

say "=== RESULT ============================================================="
printf '  PASS %d   FAIL %d\n' "$pass" "$fail"
rm -rf "$RESTIC_REPO"          # the throwaway repo never outlives the proof
echo "  throwaway restic repo deleted: $([ -d "$RESTIC_REPO" ] && echo NO || echo yes)"
[ "$fail" -eq 0 ] || exit 1
echo "  CORPUS BACKUP PROVEN END TO END"
