#!/usr/bin/env bash
# THE OPERATOR'S OWN POLICY IS THE LIST OF THINGS THEY CALLED PRIVATE. USE IT.
#
# ---------------------------------------------------------------------------------------------
# THE GAP THIS CLOSES, AND HOW IT WAS FOUND
# ---------------------------------------------------------------------------------------------
# `scripts/scan-identity.txt` is a hand-maintained list of literals the sanitiser redacts and the
# scanner hunts for. On 2026-09-08 it had four entries, and the publication tree built from HEAD
# carried FIVE MORE private directory names it had never heard of — two other projects, two data
# directories and a staging area, all named in the operator's own policy and none of them in the
# list — inside verification artifacts that had never been published before. Every existing gate
# was green: `pre-public-scan.sh` passed, `publish-rehearsal.sh` passed, and `verify-all.sh`
# reported ALL GATES GREEN.
#
# The names are not written here, for the reason in WHAT IT DELIBERATELY DOES NOT DO below. The
# first draft of this comment listed all five, which would have published them in the file whose
# entire purpose is to stop that happening.
#
# They passed correctly. A scanner that hunts for known literals cannot report a literal nobody
# told it about, and the list is maintained by hand, which means it is maintained late.
#
# THE FIX IS TO STOP MAINTAINING IT BY HAND. The operator already keeps an authoritative,
# structured list of every directory on this machine they consider private: `forbidden_paths` in
# their own `~/.usewarden/usewarden.yaml`. That is not a proxy for the answer — it IS the answer,
# written by the person whose privacy is at stake, kept current because they depend on it, and
# updated the moment they start a new private project. `allowed_paths` counts too: naming a
# project as writable is naming it, and the project names are the leak either way.
#
# So this gate derives its literals from that file — and from the timestamped backups and the
# seal beside it, so a name REMOVED from the policy is still protected. That last part is not
# hypothetical: the 2026-08-29 edit deleted entries, and the artifacts describing that edit are
# exactly the ones that still name them. It fails if any literal appears in the tree that
# publication would produce.
#
# WHAT IT DELIBERATELY DOES NOT DO
#
# It does not print the names it found. A scanner that names the private strings it hunts for, in
# output that gets pasted into a terminal, a CI log or a bug report, has published them. It prints
# the FILE and the LINE NUMBER and a masked form, which is enough to fix and not enough to leak.
#
# It is a LOCAL gate. On CI the operator's policy does not exist, and the run says UNVERIFIED
# rather than PASS — CLAUDE.md §4.4: "I could not tell" and "it is fine" are different sentences.
#
# ---------------------------------------------------------------------------------------------
#   ./scripts/scan-operator-privacy.sh [--ref=publish]
#
# Exit 0 = clean.  Exit 1 = findings, do not publish.  Exit 3 = could not scan (UNVERIFIED,
# which verify-all.sh reports and counts separately — it is not a pass).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT" || exit 2

REF=""
for a in "$@"; do
  case "$a" in
    --ref=*) REF="${a#--ref=}" ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done

POLICY_DIR="${USEWARDEN_HOME:-$HOME/.usewarden}"

# ---------------------------------------------------------------------------------------------
# Derive the literals.
# ---------------------------------------------------------------------------------------------
#
# One path segment per name: a policy entry `~/some-private-project` yields `some-private-project`.
# `~/.ssh` and `**/.env` yield nothing, because a dotfile name that every machine on earth shares
# is not an identifying string, and treating it as one would make every document in this
# repository a finding.
#
# The threshold is deliberately crude and generous in the safe direction: a segment is a candidate
# if it is 5 characters or more, is not a leading-dot name, is not a glob, and is not one of the
# generic words a policy uses about itself.
GENERIC='^(Documents|Library|Keychains|Desktop|Downloads|Pictures|Movies|Music|Public|models|dev|src|tmp|home|users|warden|usewarden|config|node_modules)$'

# ONLY `~/`-ROOTED ENTRIES, AND ONLY FROM THE SCOPE BLOCK. Both halves were learned by getting it
# wrong, and both are the difference between a gate and a nuisance:
#
#   * A first pass took every `- "..."` line in the file. `protected_branches` is such a list, so
#     `master`, `release` and `production` became "private identity strings", and the scan then
#     reported 163 findings across 46 files of the ALREADY-PUBLISHED repository — including
#     README.md and .github/workflows/. A gate that cries wolf on the word "release" is a gate
#     somebody switches off, which is the failure mode docs/CHURN-2026-08-27.md is about.
#
#   * The same pass took `id_rsa` and `id_ed25519` out of `**/id_rsa`. Those are glob rules about
#     a filename every machine on earth shares, not names of anything belonging to this operator.
#     Requiring the `~/` prefix excludes them by construction rather than by another denylist.
#
# What survives is exactly the intended set: the directories the operator named, under their own
# home, in the section of the policy that is about which directories are private.
collect_names() {
  local f
  for f in "$POLICY_DIR"/usewarden.yaml "$POLICY_DIR"/usewarden.yaml.bak-* "$POLICY_DIR"/policy-seal.yaml; do
    [ -f "$f" ] || continue
    # awk rather than sed: the `~/` test is cheap, but the "am I still inside scope:" test needs
    # state, and a stateless extractor is how the branch names got in.
    awk '
      /^[a-z_]+:/            { inscope = ($0 ~ /^scope:/) }
      inscope && /^[[:space:]]*-[[:space:]]*"~\// {
        line = $0
        sub(/^[[:space:]]*-[[:space:]]*"/, "", line)
        sub(/"[[:space:]]*$/, "", line)
        sub(/^~\//, "", line)
        print line
      }
    ' "$f"
  done | tr '/' '\n' | while IFS= read -r seg; do
    [ -n "$seg" ] || continue
    case "$seg" in
      .*|*'*'*|*'?'*) continue ;;
    esac
    [ "${#seg}" -ge 5 ] || continue
    printf '%s\n' "$seg" | grep -Eqi "$GENERIC" && continue
    printf '%s\n' "$seg"
  done | sort -u
}

NAMES="$(collect_names)"
if [ -z "$NAMES" ]; then
  echo "UNVERIFIED  no operator policy at $POLICY_DIR — nothing to derive private names from."
  echo "            This is expected on CI and is NOT a pass (CLAUDE.md §4.4)."
  exit 3
fi
COUNT="$(printf '%s\n' "$NAMES" | grep -c .)"

# ---------------------------------------------------------------------------------------------
# Scan.
# ---------------------------------------------------------------------------------------------
echo "=== OPERATOR PRIVACY SCAN ==="
echo "source of truth: $POLICY_DIR/usewarden.yaml (+ backups, + seal)"
echo "literals derived: $COUNT   (not printed — see the header)"
if [ -n "$REF" ]; then
  git rev-parse -q --verify "$REF" >/dev/null 2>&1 || { echo "no such ref: $REF" >&2; exit 2; }
  echo "scanning ref:     $REF"
else
  echo "scanning:         the working tree (tracked files)"
fi
echo

FINDINGS=0
while IFS= read -r name; do
  [ -n "$name" ] || continue
  # Masked for output: first two characters, then the length. Enough to identify which entry of
  # your own policy is involved; not enough to reconstruct it from a pasted log.
  masked="$(printf '%s' "$name" | cut -c1-2)$(printf '%*s' $(( ${#name} - 2 )) '' | tr ' ' '·')"
  if [ -n "$REF" ]; then
    hits="$(git grep -In -i -F -e "$name" "$REF" -- 2>/dev/null | sed "s|^$REF:||" | cut -d: -f1,2)"
  else
    hits="$(git grep -In -i -F -e "$name" -- 2>/dev/null | cut -d: -f1,2)"
  fi
  if [ -n "$hits" ]; then
    n="$(printf '%s\n' "$hits" | grep -c .)"
    printf 'FINDING  %-24s %d occurrence(s)\n' "$masked" "$n"
    printf '%s\n' "$hits" | sed 's/^/           /'
    FINDINGS=$((FINDINGS + 1))
  fi
done <<< "$NAMES"

echo
if [ "$FINDINGS" -eq 0 ]; then
  echo "PASS  no directory the operator declared private appears in the scanned tree."
  exit 0
fi
cat <<'EOF'
FAIL  the tree names directories the operator's own policy calls private.

  Fix ONE of these, then re-run:
    * add the name to scripts/scan-identity.txt (untracked) so the sanitiser redacts it, or
    * add the file to scripts/internal-only-paths.txt so publication drops it, or
    * edit the file so it does not name the directory at all.

  Adding it to scan-identity.txt is usually right: the sanitiser then removes it everywhere,
  including from files nobody remembered were affected.
EOF
exit 1
