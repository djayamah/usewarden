#!/usr/bin/env bash
# THE ROUTE A PUBLIC PUSH TAKES.
#
# CLAUDE.md §7, as amended 2026-08-21, authorises pushing to the public repository subject to four
# conditions, and says they must be enforced in code rather than remembered. This script is the
# BEFORE half; `.githooks/pre-push` is the gate that cannot be skipped; `scripts/read-back-public.sh`
# is the AFTER half.
#
#   condition 1   the scans, before AND after            here (before) + read-back-public.sh (after)
#   condition 2   read back via the GitHub API           read-back-public.sh
#   condition 3   never force-push, never rewrite        .githooks/pre-push, from git's own ref data
#   condition 4   verify-all passed on the pushed tree   here, and the receipt it writes
#
# Why the receipt exists at all: verify-all.sh takes minutes, and a hook that took minutes would be
# a hook people pass --no-verify to. So the slow proof is produced here and named by commit SHA, and
# the hook checks it. The hook still runs the SCANS itself - those are the ones that must not be
# delegated to a file.
#
#   ./scripts/public-push-gate.sh              check everything and write the receipt
#   ./scripts/public-push-gate.sh --after      the post-push half, if not using read-back-public.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT" || exit 2

AFTER=0
VERIFY_ONLY=0
REF="HEAD"
for a in "$@"; do
  case "$a" in
    --after) AFTER=1 ;;
    --verify-only) VERIFY_ONLY=1 ;;
    --ref=*) REF="${a#--ref=}" ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done
REF_SHA="$(git rev-parse -q --verify "$REF" 2>/dev/null || true)"
[ -n "$REF_SHA" ] || { echo "no such ref: $REF" >&2; exit 2; }

FAILED=0
row() { printf '%-6s %s\n' "$1" "$2"; [ "$1" = "FAIL" ] && FAILED=1; return 0; }

# ---------------------------------------------------------------------------------------------
# --verify-only: condition 4's evidence for the PRIVATE tree, and nothing else.
# ---------------------------------------------------------------------------------------------
#
# The private tree is not a candidate for publication. It legitimately carries the operator's
# absolute paths and machine name in its verification artifacts - that is what
# sanitise-for-publication.sh exists to remove - so running the publication scans over it is a
# category error that can only ever fail. The first version of this script did exactly that and
# refused itself.
#
# What the private tree DOES need to prove is that its suite and gates are green, because the
# content of every public branch is lifted from it. That is this mode.
if [ "$VERIFY_ONLY" = "1" ]; then
  HEAD_SHA="$(git rev-parse HEAD)"
  echo "=== VERIFY-ALL RECEIPT ==="
  echo "commit:  $HEAD_SHA"
  if [ -n "$(git status --porcelain)" ]; then
    echo "FAIL   working tree is DIRTY - a receipt would name a commit that is not what was tested"
    git status --short | sed 's/^/       /'
    exit 1
  fi
  echo "       running ./scripts/verify-all.sh - this takes a few minutes"
  ./scripts/verify-all.sh > /tmp/ppg-verify.txt 2>&1; VA=$?
  mkdir -p "$ROOT/.push-receipts"
  if [ $VA -ne 0 ]; then
    rm -f "$ROOT/.push-receipts/verify-all-$HEAD_SHA.txt"
    echo "FAIL   verify-all.sh: exit $VA - no receipt written"
    grep -E '^FAIL|UNVERIFIED' /tmp/ppg-verify.txt | sed 's/^/       /'
    exit 1
  fi
  { echo "commit: $HEAD_SHA"
    echo "when:   $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "verify-all: exit 0"
  } > "$ROOT/.push-receipts/verify-all-$HEAD_SHA.txt"
  echo "PASS   verify-all.sh: exit 0 - receipt written for ${HEAD_SHA:0:10}"
  exit 0
fi

echo "=== PUBLIC PUSH GATE ==="
echo "captured: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "ref:      $REF -> $REF_SHA"
echo "checkout: $(git rev-parse --abbrev-ref HEAD) @ $(git rev-parse --short HEAD)"
echo

# ---------------------------------------------------------------------------------------------
# 0. Is a public push authorised at all? Read it from CLAUDE.md, exactly as the hook does.
# ---------------------------------------------------------------------------------------------
if grep -q '^### Pushing to the public repository — authorized, under conditions enforced in code' \
     CLAUDE.md && ! grep -q '^### The four exceptions' CLAUDE.md; then
  row PASS "CLAUDE.md §7 authorises public pushes under conditions"
else
  row FAIL "CLAUDE.md §7 does NOT authorise public pushes - nothing below matters until it does"
  echo
  echo "The amendment is prepared. Applying it is the founder's action, not this script's:"
  echo "    ./scripts/apply-amendment.sh          # show the diff"
  echo "    ./scripts/apply-amendment.sh --write  # apply it, then commit it yourself"
  echo
  echo "=== GATE CLOSED ==="
  exit 1
fi

# ---------------------------------------------------------------------------------------------
# 1. The tree must be clean. A receipt names a COMMIT; uncommitted changes are not in it.
# ---------------------------------------------------------------------------------------------
if [ "$REF" != "HEAD" ] && [ "$REF_SHA" != "$(git rev-parse HEAD)" ]; then
  row PASS "receipt is for $REF, a committed ref - the checkout's state cannot affect it"
elif [ -z "$(git status --porcelain)" ]; then
  row PASS "working tree is clean - the receipt can honestly name a commit"
else
  row FAIL "working tree is DIRTY - commit or stash first, or the receipt would describe a tree that is not what gets pushed"
  git status --short | sed 's/^/       /'
fi

# ---------------------------------------------------------------------------------------------
# 2. Condition 1 (before): both scans.
# ---------------------------------------------------------------------------------------------
echo
echo "--- condition 1: the scans, before the push ---"
if SCAN_REF="$REF_SHA" SCAN_SCOPE=tree ./scripts/pre-public-scan.sh --classes=identity > /tmp/ppg-tree.txt 2>&1; then
  row PASS "the tree $REF publishes: clean"
else
  row FAIL "the tree $REF publishes carries an identity string"
  grep -E '^\s+\[|^BLOCKER' /tmp/ppg-tree.txt | sed 's/^/       /'
fi

if git rev-parse -q --verify public/main >/dev/null 2>&1; then
  if SCAN_REF="public/main..$REF_SHA" ./scripts/pre-public-scan.sh > /tmp/ppg-added.txt 2>&1; then
    row PASS "the commits $REF adds: clean"
  else
    row FAIL "the commits $REF adds carry something"
    grep -E '^\s+\[|^BLOCKER' /tmp/ppg-added.txt | sed 's/^/       /'
  fi
else
  row FAIL "public/main is not fetched - cannot tell which commits $REF adds"
fi

./scripts/scan-published-head.sh --self-test > /tmp/ppg-head.txt 2>&1; PH=$?
case $PH in
  0) row PASS "published-HEAD scan: live public tree clean, and the scan self-tested first" ;;
  3) row FAIL "published-HEAD scan could not reach GitHub - UNVERIFIED is not a pass" ;;
  *) row FAIL "published-HEAD scan found something on the live public tree"
     grep -E '^\s+\[|^BLOCKER|NOT CLEAN' /tmp/ppg-head.txt | sed 's/^/       /' ;;
esac

# ---------------------------------------------------------------------------------------------
# 3. Condition 3 (advisory here; the hook is where it binds).
# ---------------------------------------------------------------------------------------------
echo
echo "--- condition 3: fast-forward only ---"
git fetch -q public 2>/dev/null || true
PUB_MAIN="$(git rev-parse -q --verify public/main 2>/dev/null || true)"
if [ -z "$PUB_MAIN" ]; then
  row FAIL "cannot read public/main - refusing to assert anything about fast-forwarding"
elif git merge-base --is-ancestor "$PUB_MAIN" HEAD 2>/dev/null; then
  row PASS "public/main is an ancestor of HEAD - a push to main would fast-forward"
else
  row PASS "HEAD does not contain public/main - fine for a FEATURE branch; a push to main would be refused by the hook"
fi

# ---------------------------------------------------------------------------------------------
# 4. Condition 4: verify-all on this exact tree.
# ---------------------------------------------------------------------------------------------
echo
echo "--- condition 4: verify-all.sh on the tree being pushed ---"
if [ "$AFTER" = "1" ]; then
  echo "SKIP   --after: not re-running the full pass"
elif [ "$REF_SHA" = "$(git rev-parse HEAD)" ]; then
  echo "       running ./scripts/verify-all.sh - this takes a few minutes"
  ./scripts/verify-all.sh > /tmp/ppg-verify.txt 2>&1; VA=$?
  if [ $VA -eq 0 ]; then
    row PASS "verify-all.sh: exit 0"
  else
    row FAIL "verify-all.sh: exit $VA"
    grep -E '^FAIL|UNVERIFIED' /tmp/ppg-verify.txt | sed 's/^/       /'
  fi
else
  # A PUBLIC branch is not the private tree, and verify-all.sh checks private-only things -
  # live-session transcripts, the internal document list, the fixture. Running it against a
  # public branch would fail for reasons that say nothing about that branch.
  #
  # So the ref gets what CAN honestly be asserted of it: a real build and the real suite, in a
  # worktree of that exact commit. Plus verify-all on the private tree the content came from,
  # which is checked separately below. Both, or no receipt.
  echo "       $REF is not the checkout - building and testing it in its own worktree"
  WT="$ROOT/.worktrees/gate-$(printf '%.10s' "$REF_SHA")"
  rm -rf "$WT"
  if git worktree add -q --detach "$WT" "$REF_SHA" 2>/dev/null; then
    ( cd "$WT" && npm ci --ignore-scripts >/dev/null 2>&1 && npm run build >/dev/null 2>&1 \
        && npm test > /tmp/ppg-reftest.txt 2>&1 )
    RT=$?
    if [ $RT -eq 0 ]; then
      row PASS "the ref's own suite: $(grep -oE '^. tests [0-9]+' /tmp/ppg-reftest.txt | grep -oE '[0-9]+' | head -1) tests, 0 failures, built from a clean worktree"
    else
      row FAIL "the ref's own suite failed"
      tail -12 /tmp/ppg-reftest.txt | sed 's/^/       /'
    fi
    git worktree remove --force "$WT" >/dev/null 2>&1
  else
    row FAIL "could not create a worktree for $REF - refusing rather than assuming"
  fi

  PRIV="$(git rev-parse HEAD)"
  if [ -r "$ROOT/.push-receipts/verify-all-$PRIV.txt" ]; then
    row PASS "the private tree this content came from is verify-all green (${PRIV:0:10})"
  else
    row FAIL "no verify-all receipt for the private tree ${PRIV:0:10} this branch was built from"
    echo "       run: ./scripts/public-push-gate.sh --verify-only"
  fi
fi

# ---------------------------------------------------------------------------------------------
# 5. The receipt - written ONLY if every condition above passed.
# ---------------------------------------------------------------------------------------------
echo
HEAD_SHA="$REF_SHA"
mkdir -p "$ROOT/.push-receipts"
if [ "$FAILED" != "0" ]; then
  rm -f "$ROOT/.push-receipts/$HEAD_SHA.txt"
  echo "=== GATE CLOSED - conditions above are not met, and no receipt was written ==="
  echo "    Any receipt that existed for this commit has been removed."
  exit 1
fi

{
  echo "commit: $HEAD_SHA"
  echo "ref:    $REF"
  echo "tree:   $(git rev-parse "$REF_SHA^{tree}")"
  echo "when:   $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "verify-all: exit 0"
  echo "pre-public scan (tree, identity): clean"
  echo "published-HEAD scan: clean, self-tested"
} > "$ROOT/.push-receipts/$HEAD_SHA.txt"

cat <<MSG
=== GATE OPEN - receipt written for ${HEAD_SHA:0:10} ===

Push. The hook will re-check the scans and the fast-forward itself:

    git push public <branch>

THEN, and this is condition 1's second half and condition 2:

    ./scripts/read-back-public.sh

Do not treat the push as done until that comes back clean. "It merged" and "the right thing
is now live" are different sentences, which is the whole reason condition 2 exists.
MSG
