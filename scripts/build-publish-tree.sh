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
#
# NOTE the public repo has NO CLAUDE.md. The operator's CLAUDE.md is a fence and only works if it
# names the real private paths, so it is excluded rather than redacted; CONTRIBUTING.md carries
# the parts a contributor needs.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"

BRANCH="${PUBLISH_BRANCH:-publish}"
SRC="${1:-HEAD}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export GIT_INDEX_FILE="$TMP/index"

# The internal-only path list is READ, never restated. Two copies of this regex drifted once
# already; see scripts/internal-only-paths.txt.
internal_only_re() {
  local f="$ROOT/scripts/internal-only-paths.txt"
  [ -f "$f" ] || { echo "FATAL: scripts/internal-only-paths.txt is missing" >&2; exit 2; }
  local frags
  frags="$(sed 's/#.*//' "$f" | sed 's/[[:space:]]*$//' | grep -v '^$' | paste -sd'|' -)"
  [ -n "$frags" ] || { echo "FATAL: scripts/internal-only-paths.txt is empty" >&2; exit 2; }
  printf '^(%s)' "$frags"
}

EXCLUDE_RE="$(internal_only_re)"

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

# PARENT: the commit currently published on the public remote, so the published history is a
# normal linear history that GitHub can diff and open pull requests against. The first build has
# no parent - that is the single orphan commit the note above describes. Building every update as
# a fresh orphan (which the first version did) produces branches with "no history in common with
# main", which GitHub refuses to open a PR for.
git fetch -q "${PUBLISH_REMOTE:-public}" main 2>/dev/null || true
PARENT="$(git rev-parse --verify --quiet "refs/remotes/${PUBLISH_REMOTE:-public}/main" || true)"
if [ -n "${PUBLISH_MSG:-}" ]; then printf '%s\n' "$PUBLISH_MSG" > "$MSG"; fi

# THE PUBLICATION IDENTITY IS SET EXPLICITLY, NOT INHERITED.
#
# `git commit-tree` silently uses whatever identity the machine's git config carries. On this
# machine that is the account name at the Mac's Bonjour hostname - which is exactly the
# `bonjour-hostname` string the scanner hunts for inside files, and it is how it reached the
# public repository's root commit, where it still sits. No scan could see it: every scan read
# blobs, and this is a commit header (D-145).
#
# Publication is a deliberate act and gets a deliberate identity, passed in as PUBLISH_IDENTITY
# in the form 'Name <email>'. There is deliberately NO DEFAULT, for two reasons:
#
#   - a default of the machine's git config is how the Bonjour hostname reached the public root
#     commit in the first place (D-145), and
#   - a default of the maintainer's real address would put that address in THIS FILE, which is
#     published. The scanner caught exactly that on the first attempt: a fix for one identity leak
#     that introduced another, in the script written to prevent them.
#
# An outward-facing commit gets an identity somebody chose on purpose, at the moment of choosing.
if [ -z "${PUBLISH_IDENTITY:-}" ]; then
  echo "FATAL: PUBLISH_IDENTITY is not set. Publication commits get an identity chosen on" >&2
  echo "       purpose, not one inherited from this machine's git config." >&2
  echo "" >&2
  echo "       PUBLISH_IDENTITY='Your Name <you@example.com>' $0 $*" >&2
  echo "" >&2
  echo "       The value to use for a real publication is in ops/MY-SETUP.md, which is not" >&2
  echo "       published. scripts/publish-rehearsal.sh sets its own throwaway identity." >&2
  exit 2
fi
PUBLISH_IDENTITY="${PUBLISH_IDENTITY}"
PI_NAME="${PUBLISH_IDENTITY%% <*}"
PI_EMAIL="${PUBLISH_IDENTITY##*<}"; PI_EMAIL="${PI_EMAIL%>}"
if [ -z "$PI_NAME" ] || [ -z "$PI_EMAIL" ] || [ "$PI_NAME" = "$PUBLISH_IDENTITY" ]; then
  echo "FATAL: PUBLISH_IDENTITY must be 'Name <email>', got: $PUBLISH_IDENTITY" >&2; exit 2
fi
# Refuse to MINT what the scanner would then find. A `.local` address is a machine name, never a
# deliverable one, and this is the last point at which it is cheap to fix - once the commit is
# pushed, only a history rewrite removes it.
case "$PI_EMAIL" in
  *.local)
    echo "FATAL: PUBLISH_IDENTITY email is in the .local TLD - that is a machine hostname, and" >&2
    echo "       it would be published in the commit header where no file edit can reach it." >&2
    exit 2 ;;
esac

if [ -n "$PARENT" ]; then
  COMMIT="$(GIT_AUTHOR_NAME="$PI_NAME"     GIT_AUTHOR_EMAIL="$PI_EMAIL" \
            GIT_COMMITTER_NAME="$PI_NAME"  GIT_COMMITTER_EMAIL="$PI_EMAIL" \
            git commit-tree "$TREE" -p "$PARENT" -F "$MSG")"
else
  COMMIT="$(GIT_AUTHOR_NAME="$PI_NAME"     GIT_AUTHOR_EMAIL="$PI_EMAIL" \
            GIT_COMMITTER_NAME="$PI_NAME"  GIT_COMMITTER_EMAIL="$PI_EMAIL" \
            git commit-tree "$TREE" -F "$MSG")"
fi
git update-ref "refs/heads/$BRANCH" "$COMMIT"

echo "=== PUBLICATION TREE BUILT ==="
echo "branch:   $BRANCH"
echo "commit:   $COMMIT"
echo "source:   $SRC ($(git rev-parse --short "$SRC"))"
echo "excluded: $(printf '%s\n' "$DROP" | grep -c . || true) path(s)"
printf '%s\n' "$DROP" | grep . | sed 's/^/            /' || true
echo "included: $(git ls-tree -r --name-only "$BRANCH" | wc -l | tr -d ' ') path(s)"
echo
echo "identity: $PUBLISH_IDENTITY (set explicitly, never inherited from git config)"
if [ "${PUBLISH_SANITISED:-}" != "1" ]; then
  echo
  echo "*** THIS BRANCH IS UNSANITISED. DO NOT PUSH IT. ***"
  echo "    scripts/sanitise-for-publication.sh has NOT run over the source of this build, so the"
  echo "    tree still carries the operator's absolute paths and machine name in the verification"
  echo "    artifacts. Scanning this ref will report findings, and the findings are real."
  echo
  echo "    The publication path is ./scripts/publish-rehearsal.sh - it clones, sanitises the"
  echo "    THROWAWAY copy (the sanitiser rewrites in place and must never touch your working"
  echo "    tree), builds this same branch from that, and scans it at full strictness."
fi
echo
echo "Next: SCAN_REF=$BRANCH ./scripts/pre-public-scan.sh"
