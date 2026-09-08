#!/usr/bin/env bash
# SCAN WHAT IS PUBLISHED RIGHT NOW.
#
# ---------------------------------------------------------------------------------------------
# WHY THIS EXISTS
# ---------------------------------------------------------------------------------------------
# Every publication scan in this repository points at what we are ABOUT to ship:
#
#   ./scripts/pre-public-scan.sh --scope=tree      the files on this disk, before a push
#   SCAN_REF=publish ./scripts/pre-public-scan.sh  the branch we would publish next
#   ./scripts/publish-rehearsal.sh                 the tree a publish would produce
#
# All three answer "is the next thing clean". None answers "is the LAST thing clean", and those
# are different questions with different answers. A file that went public before a scan rule
# existed is invisible to every scan written afterwards, forever, because no scan ever looks
# backwards at the live repository.
#
# That was not theoretical. `ops/BOT-SCOPE.md` carried an operator-identity string on the public
# repository for as long as it took to notice, while the private tree had already been corrected
# and every scan on both sides said CLEAN (DECISIONS.md D-140). The private scans were right: the
# private file was fixed. The publication scan was right: the branch we would publish next was
# fixed. Nobody was asking about the copy strangers could actually read.
#
# So: fetch the CURRENT HEAD OF THE PUBLIC REPOSITORY FROM GITHUB, and scan its files.
#
# ---------------------------------------------------------------------------------------------
# WHAT MAKES THIS "FROM GITHUB" AND NOT "A LOCAL BRANCH"
# ---------------------------------------------------------------------------------------------
# `public/main` is a remote-tracking ref. It is a LOCAL cache of what GitHub said last time
# somebody fetched, and it can be arbitrarily stale - which would make this control answer a
# question about a snapshot from last week while reporting it as the live state. So:
#
#   1. ask GitHub over the wire what HEAD is, right now  (`git ls-remote`)
#   2. ask GitHub a SECOND time by a different route     (`gh api`, when available)
#   3. require the two to agree
#   4. fetch that exact commit
#   5. assert the object we scan hashes to the SHA GitHub named
#
# Step 5 is the one that matters. If the local ref is stale, or points somewhere else, or the
# fetch silently no-ops, the assertion fails and this reports UNVERIFIED rather than scanning a
# stale tree and reporting PASS.
#
# ---------------------------------------------------------------------------------------------
# READ-ONLY
# ---------------------------------------------------------------------------------------------
# This script fetches. It never pushes. Pushing to the public remote is permanent exception 1
# (CLAUDE.md section 7) and `.githooks/pre-push` refuses it by resolved URL regardless.
#
# ---------------------------------------------------------------------------------------------
# EXIT CODES - three, not two, on purpose
# ---------------------------------------------------------------------------------------------
#   0  reached GitHub, and the published tree carries no identity string
#   1  reached GitHub, and it does  (or the staleness assertion failed)
#   3  could not reach GitHub - UNVERIFIED
#
# 3 is NOT 0. A control that cannot see its subject reports that it could not see its subject
# (CLAUDE.md section 4.4: "UNVERIFIED is a failure, not a pass"). It is kept distinct from 1 only
# so a caller can tell "we looked and it is dirty" from "we could not look", which are different
# things to do about.
#
#   ./scripts/scan-published-head.sh              scan the live public HEAD
#   ./scripts/scan-published-head.sh --self-test  prove the scan FAILS on a known-bad tree first
#   ./scripts/scan-published-head.sh --ref=<sha>  scan a specific commit's files (used by --self-test)

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$REPO" || exit 2

# Everything printed goes through the same redaction the scanner uses: this script's output is
# archived into verification/, and verification/ is read by people who are not the operator.
redact() { sed -e "s|$HOME|~|g" -e "s|$(basename "$HOME")|<user>|g"; }

SELF_TEST=0
FORCE_REF=""
for arg in "$@"; do
  case "$arg" in
    --self-test) SELF_TEST=1 ;;
    --ref=*)     FORCE_REF="${arg#--ref=}" ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------------------------
# The scan itself. Delegates to the real scanner - it does NOT reimplement its rules.
# ---------------------------------------------------------------------------------------------
#
# The first version of the sibling control in verify-hardening.sh DID reimplement them: it read
# `scripts/scan-identity.txt` and looped over the lines. That file holds the EXTRA strings; the
# scanner DERIVES the hostname and account name on top of them, and the string that was actually
# exposed was a derived one. So the check looked thorough, ran without error, and reported PASS
# for a repository whose exposed string I had already read with my own eyes (D-141).
#
# A second copy of a rule drifts from the first, and the drift is worst when the wrong answer is
# the green one. There is exactly one identity scanner in this repository and this calls it.
scan_ref_tree() {
  local ref="$1"
  SCAN_REF="$ref" SCAN_SCOPE=tree ./scripts/pre-public-scan.sh --classes=identity
}

# ---------------------------------------------------------------------------------------------
# SELF-TEST: prove the scan FAILS on a known-bad tree before believing it when it passes
# ---------------------------------------------------------------------------------------------
#
# A CLEAN from a scanner that scanned nothing is byte-identical to a CLEAN from a clean tree.
# This builds a commit that is the real published tree PLUS two planted strings, asserts the
# strings really landed in that commit (CLAUDE.md section 4.2 - a sabotage test asserts the
# sabotage landed before it asserts the catch), and requires the scan to block on it.
#
# THREE planted strings on THREE different surfaces, because a self-test that only exercises the
# easy surface passes on a broken scanner:
#
#   machine-home-path   a LITERAL pattern, hard-coded in the scanner's published pattern list.
#                       Assembled at run time from fragments (see below) so that no string this
#                       file CONTAINS can match it - otherwise the scanner blocks on the script
#                       written to prove the scanner works, which is D-091 all over again.
#   operator-identity   a DERIVED string, computed at scan time from this machine's account name
#                       and never written to disk by this repository. This is the category that
#                       was actually exposed, and the category the broken first version of the
#                       hardening check could not see. It is generated at test time, planted,
#                       and never printed - not by this script, and not by the scanner, which
#                       reports identity hits as `<redacted>`.
#   commit header       the AUTHOR of the sabotage commit, in the `.local` TLD - a Bonjour
#                       hostname, never a deliverable address. Not a blob at all, and therefore
#                       invisible to passes 1 and 2 - which is how a machine identity reached the
#                       public root commit and stayed there (D-145). Assembled at run time for the
#                       same reason as the path above.
#
# WHY ASSEMBLED AND NOT WRITTEN OUT: the first attempt wrote both literals into this file and added
# an allow-list entry for their shared prefix so the scanner would ignore them. That entry also
# matched the PLANTED copy, so the machine-home-path half of this test silently stopped detecting
# anything - a weakened test that still reported PASS. This self-test caught it on the next run.
# Assembling from fragments weakens no rule anywhere.
#
# The commit is DANGLING - built with commit-tree, attached to no branch, never pushed, and
# invisible to `git rev-list --all`, so it cannot contaminate any other scan.
self_test() {
  local base="$1" rc out
  local tmp; tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN

  echo "--- SELF-TEST: does this scan actually catch anything? ---"

  local ident; ident="$(id -un 2>/dev/null || basename "$HOME")"
  if [ -z "$ident" ]; then
    echo "UNVERIFIED  could not derive an operator-identity string to plant"
    return 3
  fi

  # Fragments. Concatenated at run time, so the literals below never appear in this file and the
  # scanner has nothing here to flag - while the files this writes carry the real matching strings.
  local u_seg="Us""ers" synth_user="zz""sabotage""operator"
  local synth_host="zz""sabotage""host" local_tld="lo""cal"
  local planted_path="/${u_seg}/${synth_user}/dev/warden"
  local planted_email="sabotage@${synth_host}.${local_tld}"

  printf 'a path that names a real machine: %s\n' "$planted_path" \
    > "$tmp/SABOTAGE-home-path.md"
  printf 'this line names the operator: %s\n' "$ident" > "$tmp/SABOTAGE-identity.md"

  local b1 b2 tree commit
  b1="$(git hash-object -w "$tmp/SABOTAGE-home-path.md")" || return 2
  b2="$(git hash-object -w "$tmp/SABOTAGE-identity.md")"  || return 2

  GIT_INDEX_FILE="$tmp/index" git read-tree "$base" || return 2
  GIT_INDEX_FILE="$tmp/index" git update-index --add \
    --cacheinfo "100644,$b1,SABOTAGE-home-path.md" || return 2
  GIT_INDEX_FILE="$tmp/index" git update-index --add \
    --cacheinfo "100644,$b2,SABOTAGE-identity.md" || return 2
  tree="$(GIT_INDEX_FILE="$tmp/index" git write-tree)" || return 2
  # The commit HEADER is a third planted string, on a different surface from the two files. The
  # synthetic host exercises the `.local` rule without borrowing anybody's real machine name. This
  # is the surface that let a machine identity onto the public root commit while every scan read
  # blobs (D-145).
  commit="$(GIT_AUTHOR_NAME='sabotage'    GIT_AUTHOR_EMAIL="$planted_email" \
            GIT_COMMITTER_NAME='sabotage' GIT_COMMITTER_EMAIL="$planted_email" \
            git commit-tree "$tree" -p "$base" -m 'sabotage: planted identity strings (dangling)')" \
    || return 2

  # ---- assert the sabotage LANDED, before asserting anything about the catch ----
  local landed=0
  if [ "$(git cat-file blob "$commit:SABOTAGE-home-path.md" | grep -cF "$planted_path")" = "1" ]; then
    echo "  LANDED    the planted home-path string is really in $(printf '%.10s' "$commit"):SABOTAGE-home-path.md"
  else
    echo "  FAIL      the planted home-path string is NOT in the sabotage tree - the test set itself up wrong"
    return 1
  fi
  if [ "$(git cat-file blob "$commit:SABOTAGE-identity.md" | grep -cF "$ident")" = "1" ]; then
    echo "  LANDED    the planted operator-identity string is really in the sabotage tree (not printed)"
  else
    echo "  FAIL      the planted identity string is NOT in the sabotage tree - the test set itself up wrong"
    return 1
  fi
  # ...and assert it is NOT in the clean base, or the next step proves nothing.
  if git ls-tree -r --name-only "$base" | grep -qx 'SABOTAGE-home-path.md'; then
    echo "  FAIL      the base tree already contains the sabotage file"
    return 1
  fi
  echo "  LANDED    the base tree does not contain either planted file"
  if [ "$(git log -1 --format='%ae' "$commit")" = "$planted_email" ]; then
    echo "  LANDED    the sabotage commit header really carries a .local machine address"
  else
    echo "  FAIL      the sabotage commit does not carry the planted header - test set itself up wrong"
    return 1
  fi
  if [ "$(git log -1 --format='%ae' "$base")" = "$planted_email" ]; then
    echo "  FAIL      the base commit already carries the planted header"
    return 1
  fi

  # ---- now the catch ----
  out="$(scan_ref_tree "$commit" 2>&1)"; rc=$?
  if [ $rc -eq 0 ]; then
    echo "  FAIL      the scan reported CLEAN on a tree with two planted identity strings."
    echo "            This control cannot be trusted. Output:"
    printf '%s\n' "$out" | sed 's/^/              /'
    return 1
  fi
  if ! printf '%s' "$out" | grep -q 'machine-home-path'; then
    echo "  FAIL      the scan blocked, but did not report the planted machine-home-path"
    printf '%s\n' "$out" | sed 's/^/              /'
    return 1
  fi
  if ! printf '%s' "$out" | grep -q 'operator-identity'; then
    echo "  FAIL      the scan blocked, but did not report the planted operator-identity."
    echo "            This is the exact hole D-141 had: the DERIVED category unchecked."
    printf '%s\n' "$out" | sed 's/^/              /'
    return 1
  fi
  if ! printf '%s' "$out" | grep -q 'commit metadata'; then
    echo "  FAIL      the scan blocked on the files, but never looked at the commit HEADER."
    echo "            That is the surface D-145 found unguarded on the public root commit."
    printf '%s\n' "$out" | sed 's/^/              /'
    return 1
  fi
  # And it must not have leaked the string it found while reporting it.
  if printf '%s' "$out" | grep -qF "$ident"; then
    echo "  FAIL      the scan printed the identity string it found - the report is now the leak"
    return 1
  fi
  echo "  CAUGHT    the scan BLOCKED on the sabotage tree and named both planted file categories"
  echo "  CAUGHT    ...and flagged the planted commit HEADER, a surface no blob scan can see"
  echo "  CAUGHT    ...and reported them redacted, without echoing the string back"
  echo "  SELF-TEST PASS - a CLEAN from this scan below is worth reading"
  echo
  return 0
}

# ---------------------------------------------------------------------------------------------
# Resolve what GitHub says HEAD is, right now
# ---------------------------------------------------------------------------------------------
echo "=== PUBLISHED-HEAD SCAN ==="
echo "captured:  $(date -u '+%Y-%m-%dT%H:%M:%SZ')"

if [ -n "$FORCE_REF" ]; then
  echo "ref:       $FORCE_REF (explicit --ref, NOT the live public HEAD)"
  scan_ref_tree "$FORCE_REF"
  exit $?
fi

PUBLIC_URL="$(git remote get-url public 2>/dev/null || true)"
if [ -z "$PUBLIC_URL" ]; then
  echo "UNVERIFIED no 'public' remote is configured in this clone - nothing to scan"
  exit 3
fi
# Identify the repository by its RESOLVED URL, never by the remote's name. `.githooks/pre-push`
# makes the same choice for the same reason: a remote called `public` can be pointed anywhere,
# and a remote called something else can be the public repository.
SLUG="$(printf '%s' "$PUBLIC_URL" | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')"
echo "remote:    $PUBLIC_URL"
echo "slug:      $SLUG"

# Source 1: the git wire protocol. No auth, no API, no gh CLI.
REMOTE_HEAD="$(git ls-remote public HEAD 2>/dev/null | awk 'NR==1{print $1}')"
if [ -z "$REMOTE_HEAD" ]; then
  echo "UNVERIFIED could not reach $SLUG over the network (git ls-remote failed)"
  echo "           This is NOT a pass. The published tree was not examined."
  exit 3
fi
echo "HEAD (git ls-remote): $REMOTE_HEAD"

# Source 2: the REST API, by a different code path and a different transport concern. Two
# independent answers that must agree; one source cannot detect being pointed at the wrong place.
if command -v gh >/dev/null 2>&1; then
  API_BRANCH="$(gh api "repos/$SLUG" --jq .default_branch 2>/dev/null || true)"
  API_HEAD="$(gh api "repos/$SLUG/commits/${API_BRANCH:-main}" --jq .sha 2>/dev/null || true)"
  if [ -z "$API_HEAD" ]; then
    echo "           gh api did not answer - continuing on the git ls-remote answer alone"
  elif [ "$API_HEAD" != "$REMOTE_HEAD" ]; then
    echo "BLOCKER    GitHub gave two different answers for HEAD:"
    echo "             git ls-remote : $REMOTE_HEAD"
    echo "             REST API      : $API_HEAD  (default branch: $API_BRANCH)"
    echo "           Refusing to scan either. Resolve this before trusting any scan of this repo."
    exit 1
  else
    echo "HEAD (gh api $API_BRANCH): $API_HEAD  - AGREES"
  fi
else
  echo "           gh is not installed - continuing on the git ls-remote answer alone"
fi

# ---------------------------------------------------------------------------------------------
# Fetch it, and prove the thing we scan is the thing GitHub named
# ---------------------------------------------------------------------------------------------
if ! git fetch -q public "$REMOTE_HEAD" 2>/dev/null && ! git fetch -q public 2>/dev/null; then
  echo "UNVERIFIED could not fetch $SLUG"
  exit 3
fi
if ! git cat-file -e "${REMOTE_HEAD}^{commit}" 2>/dev/null; then
  echo "UNVERIFIED fetched, but commit $REMOTE_HEAD is not present locally - nothing was scanned"
  exit 3
fi
# The staleness assertion. Without this, everything above is decoration and the scan below could
# be reading a month-old cache.
LOCAL_TRACKING="$(git rev-parse -q --verify public/main 2>/dev/null || echo '<none>')"
if [ "$LOCAL_TRACKING" != "$REMOTE_HEAD" ]; then
  echo "note:      local public/main is $LOCAL_TRACKING, GitHub HEAD is $REMOTE_HEAD"
  echo "           scanning the SHA GitHub named, not the local ref"
fi
echo "scanning:  $REMOTE_HEAD (verified equal to the SHA GitHub reported this second)"
echo

# ---------------------------------------------------------------------------------------------
# Self-test first, when asked. A pass below means nothing if the scanner cannot fail.
# ---------------------------------------------------------------------------------------------
if [ "$SELF_TEST" = "1" ]; then
  self_test "$REMOTE_HEAD"; ST=$?
  if [ $ST -ne 0 ]; then
    echo "=== SELF-TEST FAILED - this control proves nothing. Fix it before reading its verdict. ==="
    exit 1
  fi
fi

scan_ref_tree "$REMOTE_HEAD"; RC=$?
echo
if [ $RC -eq 0 ]; then
  echo "=== PUBLISHED HEAD CLEAN - $SLUG@$(printf '%.10s' "$REMOTE_HEAD") carries no identity string ==="
  echo
  echo "    SCOPE, stated plainly so this is not over-read: this is the CURRENT FILES of the"
  echo "    published HEAD. It says nothing about the repository's HISTORY. A string that was"
  echo "    published once and later corrected stays reachable by SHA in a public repository for"
  echo "    a long time, and only a history rewrite removes it. That is a separate control and a"
  echo "    separate decision - see verify-hardening.sh and DECISIONS.md D-142."
  exit 0
fi
echo "=== PUBLISHED HEAD IS NOT CLEAN - $SLUG@$(printf '%.10s' "$REMOTE_HEAD") ==="
echo "    Something identifying is readable by anyone, right now. The fix is a PR on the public"
echo "    repository; pushing there is permanent exception 1 and belongs to the founder."
exit 1
