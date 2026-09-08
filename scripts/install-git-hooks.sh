#!/usr/bin/env bash
# Points git at the tracked .githooks/ directory, then PROVES the hook is live.
#
# `git config core.hooksPath` returning 0 is not evidence that a hook runs - that is exactly the
# "an edit that returns exit 0 has not been verified" failure CLAUDE.md §4.1 names. So this runs
# the hook against the forbidden URL and against an allowed one, and fails loudly if either
# answer is wrong.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$REPO"
FAILED=0

git config core.hooksPath .githooks
echo "core.hooksPath = $(git config core.hooksPath)"

# Overridable ONLY so the watchdog above can be proven against a deliberately hanging stub. The
# default is the real hook and nothing in the repository sets this.
HOOK="${PRE_PUSH_HOOK:-$REPO/.githooks/pre-push}"
[ -x "$HOOK" ] || { echo "FAIL  $HOOK is not executable"; exit 1; }

# THE HOOK READS ITS REF DATA FROM STDIN, AND THIS SELF-TEST MUST GIVE IT SOME.
#
# It did not, and the consequence was worse than a wrong answer: `git` feeds a pre-push hook one
# line per ref on stdin, so with stdin inherited from this script the hook BLOCKED ON READ
# FOREVER on the first public-URL case. `./scripts/verify-all.sh` calls this script, so
# verify-all hung indefinitely rather than failing - and it has therefore not completed since the
# hook gained stdin parsing (D-155/D-156). A green verification record older than that change is
# a record of a different hook.
#
# Two things stop it recurring, because closing stdin fixes today's cause and not the class:
#   1. every invocation is fed ref data on stdin, which closes when the data ends;
#   2. a watchdog kills the hook after HOOK_TIMEOUT and reports it as a FAILURE. A self-test that
#      hangs is indistinguishable from a slow machine, and "it is still running" is how this went
#      unnoticed. A hang is now a named failure, which is CLAUDE.md §4.5: a halt must never
#      resemble a completion.
HOOK_TIMEOUT="${HOOK_TIMEOUT:-30}"

LSHA="$(git rev-parse HEAD)"
RSHA="$(git rev-parse public/main 2>/dev/null || git rev-parse HEAD)"
# One ref, in git's documented pre-push format: <local ref> <local sha> <remote ref> <remote sha>.
REFLINE="refs/heads/main $LSHA refs/heads/main $RSHA"

check() {  # label expected-exit remote-name remote-url [stdin-payload, default one ref line]
  local label="$1" want="$2" name="$3" url="$4"
  local payload="${5-$REFLINE}"

  printf '%s\n' "$payload" | "$HOOK" "$name" "$url" >/dev/null 2>&1 &
  local pid=$!
  ( sleep "$HOOK_TIMEOUT"; kill -9 "$pid" 2>/dev/null ) >/dev/null 2>&1 &
  local watchdog=$!
  wait "$pid"; local got=$?
  kill "$watchdog" 2>/dev/null; wait "$watchdog" 2>/dev/null

  # 137 = SIGKILL from the watchdog. Named explicitly so it never reads as an ordinary refusal.
  if [ "$got" -eq 137 ]; then
    printf 'FAIL  %s: HUNG - killed after %ss. The hook is waiting on something (stdin?).\n' \
      "$label" "$HOOK_TIMEOUT"; FAILED=1
  elif [ "$got" -eq "$want" ]; then printf 'PASS  %s (exit %s)\n' "$label" "$got"
  else printf 'FAIL  %s: expected exit %s, got %s\n' "$label" "$want" "$got"; FAILED=1; fi
}

# REFUSED. Note what these now prove and what they no longer do: §7 authorises public pushes under
# four conditions, so a public URL is no longer refused for BEING public - it is refused because
# the conditions are not satisfied from a bare invocation (no verify-all receipt naming the
# commit). The exit code is the same and the reason is not, so the labels say so.
check "public https URL: conditions unmet, refused"   1 public "https://github.com/djayamah/usewarden.git"
check "public ssh URL: conditions unmet, refused"     1 anything "<email-redacted>:djayamah/usewarden.git"
check "public URL under a lying remote name, refused" 1 origin "https://github.com/djayamah/usewarden.git"
check "no URL is refused (fail closed)"               1 public ""
# A push with NOTHING on stdin must still not be waved through on the public remote.
check "public URL with no refs on stdin, refused"     1 public "https://github.com/djayamah/usewarden.git" ""
# ALLOWED.
check "private origin allowed"        0 origin "https://github.com/djayamah/warden.git"
check "private ssh origin allowed"    0 origin "<email-redacted>:djayamah/warden.git"

if [ $FAILED -eq 0 ]; then echo "=== git hooks installed and PROVEN ==="; else echo "=== GIT HOOKS NOT PROVEN ==="; fi
exit $FAILED
