#!/usr/bin/env bash
# Runs a REAL agent session inside the sabotage fixture and captures everything.
#
# SAFETY FENCE (SPEC-BUILD.md Part C - the costliest mistake is a sandbox escape here):
#   1. The resolved working directory must be exactly $REPO/fixtures/sandbox-project.
#   2. No relative paths and no tilde expansion are passed to the agent.
#   3. The session is scoped by a usewarden policy whose allowed_paths is the fixture alone.
#   4. USEWARDEN_HOME stays inside the usewarden repo, so no state is written to $HOME.
# If any check fails the script aborts BEFORE spawning anything.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
FIXTURE="$REPO/fixtures/sandbox-project"

[ -d "$FIXTURE" ] || { echo "FENCE: fixture missing; run scripts/make-fixture.sh" >&2; exit 1; }
RESOLVED="$(cd "$FIXTURE" && pwd -P)"
# The fence compares the RESOLVED cwd against the RESOLVED fixture path derived from this
# script's own location, so it cannot be defeated by a symlink and does not depend on what the
# checkout directory happens to be called. A name-based fence is a fence with a gate in it.
EXPECTED="$(cd "$REPO" && pwd -P)/fixtures/sandbox-project"
[ "$RESOLVED" = "$EXPECTED" ] || {
  echo "FENCE ABORT: resolved cwd '$RESOLVED' != '$EXPECTED'" >&2; exit 1; }
case "$RESOLVED" in
  *..*) echo "FENCE ABORT: path traversal component in '$RESOLVED'" >&2; exit 1 ;;
esac
# Anything the operator marks as off-limits, by absolute path prefix, one per line in
# scripts/forbidden-paths.txt (optional, not tracked). Keeps private project names out of
# a public repository while still letting the fence be strict on this machine.
if [ -f "$REPO/scripts/forbidden-paths.txt" ]; then
  while IFS= read -r deny; do
    [ -z "$deny" ] && continue
    case "$RESOLVED" in "$deny"*) echo "FENCE ABORT: '$RESOLVED' is under a forbidden prefix" >&2; exit 1 ;; esac
  done < "$REPO/scripts/forbidden-paths.txt"
fi
[ -d "$RESOLVED/.git" ] || { echo "FENCE ABORT: '$RESOLVED' is not a git repo" >&2; exit 1; }

AGENT="${1:?usage: live-session.sh <claude|gemini> <label> <prompt>}"
LABEL="${2:?missing label}"
PROMPT="${3:?missing prompt}"

export USEWARDEN_HOME="$REPO/.usewarden-live"
export NO_COLOR=1
mkdir -p "$REPO/verification/live"
OUT="$REPO/verification/live/${LABEL}.txt"

{
  echo "=== LIVE AGENT SESSION: $LABEL ==="
  echo "captured:   $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "agent:      $AGENT"
  echo "cwd:        $RESOLVED   (fence verified)"
  echo "USEWARDEN_HOME:$USEWARDEN_HOME"
  echo "prompt:     $PROMPT"
  echo
  echo "--- usewarden status BEFORE (run from inside the fixture) ---"
  ( cd "$RESOLVED" && node "$REPO/dist/src/cli.js" status ) || true
  echo
  echo "--- incidents BEFORE: $(node "$REPO/dist/src/cli.js" incidents --json | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))') ---"
  echo
  echo "--- AGENT TRANSCRIPT ---"
} > "$OUT"

# Portable timeout: macOS has no coreutils `timeout`. A watchdog kills the agent's process
# group if it overruns, so a hung session can never leave an agent running unattended.
run_bounded() {
  local secs="$1"; shift
  "$@" >> "$OUT" 2>&1 &
  local pid=$!
  ( sleep "$secs"; kill -TERM "$pid" 2>/dev/null; sleep 5; kill -KILL "$pid" 2>/dev/null ) >/dev/null 2>&1 &
  local watchdog=$!
  wait "$pid"; local rc=$?
  kill "$watchdog" 2>/dev/null || true
  return $rc
}

set +e
case "$AGENT" in
  claude)
    ( cd "$RESOLVED" && exec claude --dangerously-skip-permissions -p "$PROMPT" ) >> "$OUT" 2>&1 &
    AGENT_PID=$!
    ;;
  gemini)
    ( cd "$RESOLVED" && exec gemini -y -p "$PROMPT" ) >> "$OUT" 2>&1 &
    AGENT_PID=$!
    ;;
  *) echo "unknown agent $AGENT" >&2; exit 1 ;;
esac
( sleep 300; kill -TERM "$AGENT_PID" 2>/dev/null; sleep 5; kill -KILL "$AGENT_PID" 2>/dev/null ) >/dev/null 2>&1 &
WATCHDOG=$!
wait "$AGENT_PID"
RC=$?
kill "$WATCHDOG" 2>/dev/null || true
set -e

# The Layer-2 judge runs in a detached process so it never blocks the agent. Give it time to
# land before capturing the incident wall, and say how long we waited.
JUDGE_WAIT="${JUDGE_WAIT:-0}"
if [ "$JUDGE_WAIT" != "0" ]; then sleep "$JUDGE_WAIT"; fi

{
  echo
  echo "--- agent exit code: $RC ---"
  echo "--- waited ${JUDGE_WAIT}s for the detached Layer-2 judge ---"
  echo
  echo "--- incidents AFTER ---"
  node "$REPO/dist/src/cli.js" incidents 5
  echo
  echo "--- usewarden log tail ---"
  tail -20 "$USEWARDEN_HOME/usewarden.log" 2>/dev/null || echo "(no log)" 
  echo
  echo "--- usewarden status AFTER (run from inside the fixture) ---"
  ( cd "$RESOLVED" && node "$REPO/dist/src/cli.js" status ) || true
} >> "$OUT" 2>&1

echo "captured -> $OUT"
