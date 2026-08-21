#!/usr/bin/env bash
# PUBLICATION REHEARSAL - build what publication would publish, and scan THAT.
#
# This is the gate that matters, and it is the one CI runs on every push.
#
# The private repository's own history is deliberately NOT the gate. Publication does not push it:
# scripts/build-publish-tree.sh writes a single commit containing the public subset of HEAD, for
# the reason in DECISIONS.md D-051 - rewriting history leaves the old blobs fetchable by SHA on a
# public repo, so a fresh single-commit history is used instead. Gating every push on a scan of
# immutable private history asks a question publication never asks, can never go green, and so
# gets ignored. This script asks the real question instead:
#
#   1. sanitise a THROWAWAY copy of the tree (the sanitiser rewrites files in place, and it must
#      never touch the operator's working tree)
#   2. build the publication tree from it, dropping every internal-only path
#   3. scan that ref at FULL strictness - both passes, both classes, no exemptions
#
# It would have caught the drift that started all this: build-publish-tree.sh and
# sanitise-for-publication.sh each carried their own copy of the internal-only path list and the
# copies had diverged. Both now read scripts/internal-only-paths.txt, and a divergence here is a
# red build rather than a file published unredacted.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"
WORK="$ROOT/.publish-rehearsal"

# Inside the repo on purpose: CLAUDE.md pins all work to this directory, and a rehearsal that
# writes to /tmp is a rehearsal that writes outside the fence.
rm -rf "$WORK"
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT

echo "=== PUBLICATION REHEARSAL ==="
echo "source:   $(git rev-parse --short HEAD)"

# A clone, not a copy: the publisher works with git plumbing and needs a real repository. Local
# path clone, no network.
git clone -q --no-hardlinks "$ROOT" "$WORK/repo" || { echo "FAIL: could not clone" >&2; exit 1; }
cd "$WORK/repo"
git config user.email "rehearsal@localhost"
git config user.name  "publication rehearsal"

# The identity strings the scanner derives are machine-derived, so the untracked identity file has
# to come across too - it is deliberately not committed, because a scanner that ships the private
# names it hunts for has published them. On CI that file does not exist and the runner's own
# hostname is generic, so the CI run checks the PATTERNS and the local run additionally checks the
# operator's literal strings. Neither run pretends to be the other.
[ -f "$ROOT/scripts/scan-identity.txt" ] && cp "$ROOT/scripts/scan-identity.txt" scripts/ || true

echo
echo "--- 1. sanitise (throwaway copy) ---"
./scripts/sanitise-for-publication.sh || { echo "FAIL: sanitiser exited non-zero" >&2; exit 1; }
git add -A
git commit -q -m "sanitised for publication rehearsal" || echo "  (nothing to sanitise)"

echo
echo "--- 2. build the publication tree ---"
# PUBLISH_SANITISED=1 is the rehearsal asserting, in band, that step 1 really ran over the source
# of this build. Without it build-publish-tree.sh prints a loud DO-NOT-PUSH banner, because a
# `publish` branch built straight from an operator's working tree looks identical to this one and
# is not the same thing at all.
# A throwaway identity, because the rehearsal is not a publication. `.localhost` is reserved and
# is not the `.local` Bonjour TLD the scanner refuses, so this exercises the same code path a real
# publication takes without borrowing anybody's address.
PUBLISH_SANITISED=1 PUBLISH_REMOTE=none \
  PUBLISH_IDENTITY='publication rehearsal <rehearsal@localhost>' \
  ./scripts/build-publish-tree.sh HEAD \
  || { echo "FAIL: publish tree" >&2; exit 1; }

echo
echo "--- 3. scan the publication ref at full strictness ---"
SCAN_REF=publish ./scripts/pre-public-scan.sh
RC=$?

cd "$ROOT"
echo
if [ $RC -ne 0 ]; then
  echo "=== REHEARSAL BLOCKED - publication would push something it should not ==="
elif [ "${SCAN_SKIP_GITLEAKS:-}" = "1" ]; then
  # Said plainly rather than folded into a green tick. CI runs without gitleaks on purpose -
  # pulling a third-party scanner binary into a workflow is the supply-chain surface this
  # repository pins action SHAs to avoid - so the CI run is the pattern pass only. The run that
  # authorises a visibility change is the local one, with gitleaks present.
  echo "=== REHEARSAL CLEAN (PATTERN PASS ONLY) - gitleaks did not run ==="
  echo "    This is NOT the publication gate. Run it locally with gitleaks installed before any"
  echo "    visibility change."
else
  echo "=== REHEARSAL CLEAN - what publication would push scans clean, both passes ==="
fi
exit $RC
