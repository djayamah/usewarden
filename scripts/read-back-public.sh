#!/usr/bin/env bash
# THE AFTER HALF: read back what actually landed, and scan it again.
#
# CLAUDE.md §7 condition 2: "Read back what actually landed via the GitHub API rather than trusting
# the merge." Condition 1's second half: "and again after."
#
# Why this is not paranoia. A merge is not an identity function. A squash merge rewrites the commit.
# A rebase merge rewrites every SHA. A branch-protection rule can reject a merge after the UI has
# already said it queued. Someone else can push between your merge and your assumption. Three
# separate findings in this repository came from reading what GitHub actually serves rather than
# what the local tree said - D-140, D-145, D-152 - and D-152 was precisely "the fix is in the repo
# where it does not run".
#
#   ./scripts/read-back-public.sh                          scan the live head, list what landed
#   ./scripts/read-back-public.sh --ref=<branch> --expect <path>...
#                                                          additionally assert those paths on public
#                                                          main are byte-identical to that branch's
#                                                          copies. Use --ref: the checkout is almost
#                                                          never the branch you pushed.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT" || exit 2

EXPECT=()
COLLECT=0
SRC_REF=""
for a in "$@"; do
  case "$a" in
    --expect) COLLECT=1 ;;
    --ref=*) SRC_REF="${a#--ref=}" ;;
    -*) echo "unknown argument: $a" >&2; exit 2 ;;
    *) [ "$COLLECT" = "1" ] && EXPECT+=("$a") || { echo "unexpected argument: $a" >&2; exit 2; } ;;
  esac
done

FAILED=0
row() { printf '%-6s %s\n' "$1" "$2"; [ "$1" = "FAIL" ] && FAILED=1; return 0; }

echo "=== READ BACK WHAT LANDED ==="
echo "captured: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"

PUBLIC_URL="$(git remote get-url public 2>/dev/null || true)"
[ -n "$PUBLIC_URL" ] || { echo "FAIL   no 'public' remote configured"; exit 1; }
SLUG="$(printf '%s' "$PUBLIC_URL" | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')"
echo "repo:     $SLUG"
echo

# ---------------------------------------------------------------------------------------------
# 1. What does GitHub say HEAD is? Ask the API, not the local cache.
# ---------------------------------------------------------------------------------------------
command -v gh >/dev/null 2>&1 || { echo "FAIL   gh is not installed - condition 2 needs the API"; exit 1; }
API_SHA="$(gh api "repos/$SLUG/commits/main" --jq .sha 2>/dev/null || true)"
if [ -z "$API_SHA" ]; then
  row FAIL "the GitHub API did not answer - what landed is UNVERIFIED, which is not a pass"
  echo; echo "=== READ-BACK INCOMPLETE ==="; exit 1
fi
row PASS "GitHub API reports main = ${API_SHA:0:10}"

WIRE_SHA="$(git ls-remote public HEAD 2>/dev/null | awk 'NR==1{print $1}')"
if [ "$WIRE_SHA" != "$API_SHA" ]; then
  row FAIL "the API and the git wire protocol disagree about HEAD ($API_SHA vs $WIRE_SHA)"
else
  row PASS "the git wire protocol agrees"
fi

echo
echo "--- the last three commits, as GitHub serves them ---"
gh api "repos/$SLUG/commits?per_page=3" \
  --jq '.[] | "  \(.sha[0:10])  \(.commit.author.date)  \(.commit.message | split("\n")[0])"' 2>/dev/null

# ---------------------------------------------------------------------------------------------
# 2. Condition 1, second half: scan it again, now that it is live.
# ---------------------------------------------------------------------------------------------
echo
echo "--- condition 1 (after): scan the live public head ---"
./scripts/scan-published-head.sh --self-test > /tmp/rbp-head.txt 2>&1; PH=$?
case $PH in
  0) row PASS "published-HEAD scan: clean, and the scan self-tested first" ;;
  3) row FAIL "published-HEAD scan could not reach GitHub - UNVERIFIED, not a pass" ;;
  *) row FAIL "published-HEAD scan found something on what is now live"
     grep -E '^\s+\[|^BLOCKER|NOT CLEAN' /tmp/rbp-head.txt | sed 's/^/       /'
     echo
     echo "  §7 condition 1 says: any finding at all - revert if already pushed, and report."
     echo "  Reverting means a NEW commit that removes it. Never a force-push (condition 3)." ;;
esac

# ---------------------------------------------------------------------------------------------
# 3. Optional: are the specific files we pushed the ones now being served?
# ---------------------------------------------------------------------------------------------
if [ "${#EXPECT[@]}" -gt 0 ]; then
  echo
  echo "--- do the pushed files match what is live, byte for byte? ---"
  # WHICH LOCAL COPY? Not the checkout, unless you say so.
  #
  # The first version hashed the working-tree file. For a public push the checkout is almost never
  # the branch you pushed - it is private `main`, whose README legitimately says a different test
  # count because it is a different file shipping a different subset. So this reported
  # "README.md DIFFERS" on a merge that had landed perfectly, which is a false FAIL in a control
  # whose entire job is to be believed when it says something is wrong.
  #
  # --ref=<branch> compares against that ref's copy. Without it, the checkout is used and the
  # header below says so, so a mismatch can be read correctly rather than acted on blindly.
  if [ -n "$SRC_REF" ]; then
    echo "       comparing against $SRC_REF, not the checkout"
  else
    echo "       comparing against the CHECKOUT ($(git rev-parse --abbrev-ref HEAD)) - pass"
    echo "       --ref=<branch> if that is not the source of this push"
  fi
  for f in "${EXPECT[@]}"; do
    if [ -n "$SRC_REF" ]; then
      LOCAL_HASH="$(git rev-parse -q --verify "$SRC_REF:$f" 2>/dev/null || echo missing)"
    else
      LOCAL_HASH="$(git hash-object "$f" 2>/dev/null || echo missing)"
    fi
    REMOTE_B64="$(gh api "repos/$SLUG/contents/$f?ref=main" --jq .content 2>/dev/null || true)"
    if [ -z "$REMOTE_B64" ]; then
      row FAIL "$f is NOT present on public main"
      continue
    fi
    REMOTE_HASH="$(printf '%s' "$REMOTE_B64" | base64 -d 2>/dev/null | git hash-object --stdin)"
    if [ "$LOCAL_HASH" = "$REMOTE_HASH" ]; then
      row PASS "$f matches (${LOCAL_HASH:0:10})"
    else
      row FAIL "$f DIFFERS - local ${LOCAL_HASH:0:10}, live ${REMOTE_HASH:0:10}"
    fi
  done
fi

echo
if [ "$FAILED" = "0" ]; then
  echo "=== READ-BACK CLEAN - what is live is what was meant, and it scans clean ==="
  exit 0
fi
echo "=== READ-BACK FOUND SOMETHING - see above. §7 condition 1: report it. ==="
exit 1
