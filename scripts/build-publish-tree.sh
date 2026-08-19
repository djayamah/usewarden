#!/usr/bin/env bash
# BUILD THE PUBLICATION TREE
#
# Creates/updates the `publish` branch: a SINGLE ORPHAN COMMIT containing the public subset of
# the current HEAD. It never touches the working tree - the whole thing is built with plumbing
# against a temporary index.
#
# WHY AN ORPHAN COMMIT AND NOT A HISTORY REWRITE (DECISIONS.md D-051):
#   The build history contains this machine's absolute paths, its hostname, and private project
#   names in 22 commits' worth of blobs. `git filter-repo` would rewrite the branch, but GitHub
#   keeps UNREACHABLE objects fetchable by SHA for a long time, and on a PUBLIC repository that
#   is a real exposure - the standard advice after a leak is a fresh repository, not a rewrite.
#   The account's token does not carry `delete_repo`, so the old repository cannot be deleted
#   either. A brand-new repository with a single clean commit has no unreachable objects at all.
#
# WHAT IS EXCLUDED, AND WHY EACH ONE:
#   CLAUDE.md          - the operator's fence; it only works if it names the real private paths
#   SPEC-BUILD.md      - the founder's internal build spec, incl. forbidden-path rules
#   PROGRESS.md        - internal build log
#   FINAL-REPORT.md    - written for the founder, not for users
#   BUILD_COMPLETE     - build-harness marker
#   launch/            - unpublished marketing drafts and name research
#   ops/SETUP-*.md     - the founder's account-configuration runbooks
#   .claude/           - this machine's session hooks and current-phase notes
#   scripts/progress-snapshot.sh, verification/precompact-hook*  - build-harness only
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"

BRANCH="${PUBLISH_BRANCH:-publish}"
SRC="${1:-HEAD}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export GIT_INDEX_FILE="$TMP/index"

EXCLUDE_RE='^(CLAUDE\.md|SPEC-BUILD\.md|PROGRESS\.md|FINAL-REPORT\.md|BUILD_COMPLETE|launch/|ops/SETUP-|\.claude/|scripts/progress-snapshot\.sh|verification/precompact-hook)'

git read-tree "$SRC"
DROP="$(git ls-files --cached | grep -E "$EXCLUDE_RE" || true)"
if [ -n "$DROP" ]; then
  printf '%s\n' "$DROP" | while IFS= read -r f; do git update-index --force-remove "$f"; done
fi

TREE="$(git write-tree)"
MSG="$TMP/msg"
cat > "$MSG" <<'COMMITMSG'
usewarden 0.1.0

A firewall for your AI coding agents. Watches every agent on the machine for
drift, blocks out-of-scope actions, and shows you what it caught.

This is a single-commit history by design. The tool was built over eleven
verified phases in a private repository whose commits contain the build
machine's absolute paths and internal notes; publishing a rewritten version of
that history would leave the original blobs fetchable by SHA. The engineering
record it would have carried is published instead as DECISIONS.md and the
artifacts under verification/, both of which are checked by
scripts/pre-public-scan.sh before every push.
COMMITMSG

COMMIT="$(git commit-tree "$TREE" -F "$MSG")"
git update-ref "refs/heads/$BRANCH" "$COMMIT"

echo "=== PUBLICATION TREE BUILT ==="
echo "branch:   $BRANCH"
echo "commit:   $COMMIT"
echo "source:   $SRC ($(git rev-parse --short "$SRC"))"
echo "excluded: $(printf '%s\n' "$DROP" | grep -c . || true) path(s)"
printf '%s\n' "$DROP" | grep . | sed 's/^/            /' || true
echo "included: $(git ls-tree -r --name-only "$BRANCH" | wc -l | tr -d ' ') path(s)"
echo
echo "Next: SCAN_REF=$BRANCH ./scripts/pre-public-scan.sh"
