#!/usr/bin/env bash
# Materializes the sabotage fixture from the tracked seed in fixtures/_seed/.
#
# The fixture repos carry their own git history, which is why they cannot be committed into
# usewarden's repo directly (git would turn them into gitlinks). The seed is tracked; the working
# fixture is generated. Idempotent: re-running rebuilds it from scratch.
#
# SAFETY: this script only ever writes under $REPO/fixtures/. It refuses to run anywhere else.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
FIXTURES="$REPO/fixtures"
SEED="$FIXTURES/_seed"

# The guard identifies the repo by its CONTENT, not by the name of the directory it happens to
# be checked out into. A directory-name check breaks the moment anyone clones into a different
# folder - which is exactly what happened when the package was renamed while the working copy
# kept its old directory name.
PKGNAME="$(python3 -c "import json;print(json.load(open('$REPO/package.json'))['name'])" 2>/dev/null || echo '')"
if [ "$PKGNAME" != "usewarden" ] || [ ! -d "$FIXTURES/_seed" ]; then
  echo "refusing to run: $REPO is not a usewarden checkout (package name='$PKGNAME')" >&2
  exit 1
fi
[ -d "$SEED" ] || { echo "missing seed dir: $SEED" >&2; exit 1; }

for name in sandbox-project sibling-repo; do
  target="$FIXTURES/$name"
  # Belt and braces: the resolved target must still be inside $FIXTURES.
  case "$target" in "$FIXTURES"/*) ;; *) echo "refusing: $target escapes $FIXTURES" >&2; exit 1 ;; esac
  rm -rf "$target"
  mkdir -p "$target"
  cp -R "$SEED/$name/." "$target/"
  git -C "$target" init -q -b main
  git -C "$target" config user.email fixture@usewarden.invalid
  git -C "$target" config user.name  "usewarden fixture"
  git -C "$target" add -A
  git -C "$target" commit -q -m "initial fixture commit"
done

# A local bare remote so protected-branch sabotage (force-push) is actually attemptable.
# It lives inside fixtures/ too, so nothing can reach a real remote.
REMOTE="$FIXTURES/remote.git"
rm -rf "$REMOTE"
git init -q --bare "$REMOTE"
git -C "$FIXTURES/sandbox-project" remote add origin "$REMOTE"
git -C "$FIXTURES/sandbox-project" push -q origin main
git -C "$FIXTURES/sandbox-project" branch --set-upstream-to=origin/main main >/dev/null 2>&1 || true

# A little real history in the sandbox so `git reset --hard` and checkpoints mean something.
SP="$FIXTURES/sandbox-project"
echo "export const VERSION = '0.0.1';" > "$SP/src/version.js"
git -C "$SP" add -A
git -C "$SP" commit -q -m "add version export"
git -C "$SP" tag -f v0.0.1 >/dev/null

echo "fixture ready:"
echo "  $SP            ($(git -C "$SP" rev-list --count HEAD) commits, branch $(git -C "$SP" rev-parse --abbrev-ref HEAD))"
echo "  $FIXTURES/sibling-repo  ($(git -C "$FIXTURES/sibling-repo" rev-list --count HEAD) commits)"
echo "  $REMOTE  (bare local remote for force-push sabotage)"
