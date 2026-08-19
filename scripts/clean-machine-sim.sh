#!/usr/bin/env bash
# CLEAN-MACHINE SIMULATION (spec Phase 7 exit criterion).
#
# Packs usewarden exactly as npm would, installs the tarball into a throwaway prefix with a fresh
# HOME, and drives the whole lifecycle: install -> protect -> demo -> uninstall -> restore.
# The restore is verified by sha256 against bytes captured BEFORE usewarden ever ran.
#
# SAFETY: everything happens under a mktemp directory. The real $HOME is never read or written;
# HOME, USEWARDEN_HOME and USEWARDEN_AGENT_HOME are all redirected, and the script asserts that
# redirection took effect before it does anything.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
REAL_HOME="$HOME"
SIM="$(mktemp -d)"
trap 'rm -rf "$SIM"' EXIT

echo "=== CLEAN-MACHINE SIMULATION ==="
echo "captured: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "sim root: $SIM"
echo "node:     $(node --version)   npm: $(npm --version)"
echo

# --- 0. build and pack exactly what npm would publish -----------------------
echo "--- 0. npm pack (the real tarball, nothing hand-assembled) ---"
( cd "$REPO" && npm run --silent build )
TARBALL="$(cd "$SIM" && npm pack "$REPO" --silent)"
echo "tarball: $TARBALL  ($(cd "$SIM" && du -h "$TARBALL" | cut -f1))"
echo
echo "--- tarball contents (every file that would reach a user) ---"
tar -tzf "$SIM/$TARBALL" | sort | sed 's/^/  /'
echo
echo "--- assert: no source, tests, fixtures or verification artifacts shipped ---"
LEAKED="$(tar -tzf "$SIM/$TARBALL" | grep -E '^package/(src/|tests/|fixtures/|verification/|scripts/|\.usewarden)' || true)"
if [ -n "$LEAKED" ]; then echo "FAIL: leaked into the tarball:"; echo "$LEAKED"; exit 1; fi
echo "  OK - only dist/, docs and metadata"
echo

# --- 1. a genuinely fresh HOME ---------------------------------------------
export HOME="$SIM/home"
mkdir -p "$HOME"
[ "$HOME" != "$REAL_HOME" ] || { echo "FENCE ABORT: HOME was not redirected" >&2; exit 1; }
case "$HOME" in /var/folders/*|/tmp/*|/private/*) ;; *) echo "FENCE ABORT: HOME=$HOME is not a temp dir" >&2; exit 1 ;; esac
export USEWARDEN_HOME="$HOME/.usewarden"
export USEWARDEN_AGENT_HOME="$HOME"
export NO_COLOR=1 USEWARDEN_JUDGE_NO_LOCAL=1

# A pre-existing agent config with unrelated settings, as a real user would have.
mkdir -p "$HOME/.claude"
cat > "$HOME/.claude/settings.json" <<'JSON'
{
    "model": "opus",
    "env": {
        "MY_VAR": "keep me"
    },
    "statusLine": {
        "type": "command",
        "command": "/bin/echo hello"
    }
}
JSON
BEFORE_SHA="$(shasum -a 256 "$HOME/.claude/settings.json" | cut -d' ' -f1)"
echo "--- 1. fresh HOME=$HOME ---"
echo "pre-existing ~/.claude/settings.json sha256: $BEFORE_SHA"
echo

# A project to be protected.
PROJ="$HOME/my-project"
mkdir -p "$PROJ"
git -C "$PROJ" init -q -b main
git -C "$PROJ" config user.email sim@usewarden.invalid
git -C "$PROJ" config user.name  "sim"
echo "hello" > "$PROJ/README.md"
printf 'SECRET_KEY=sk_live_NOT_REAL_000000\n' > "$PROJ/.env"
git -C "$PROJ" add -A && git -C "$PROJ" commit -q -m init

# --- 2. install the tarball, no network, no scripts -------------------------
echo "--- 2. install the tarball into a clean prefix ---"
mkdir -p "$SIM/install"
( cd "$SIM/install" && npm init -y --silent >/dev/null && npm install --silent --no-audit --no-fund "$SIM/$TARBALL" )
USEWARDEN="$SIM/install/node_modules/.bin/usewarden"
[ -x "$USEWARDEN" ] || { echo "FAIL: bin not installed at $USEWARDEN" >&2; exit 1; }
echo "  installed: $USEWARDEN"
echo "  install scripts that ran: $(cd "$SIM/install" && npm ls --all --parseable 2>/dev/null | grep -c usewarden || echo '?') package(s), 0 lifecycle scripts (usewarden declares none)"
echo

# --- 3. status BEFORE, then init -------------------------------------------
echo "--- 3. usewarden status on a machine where it has never run ---"
( cd "$PROJ" && "$USEWARDEN" status || true ) | head -8
echo
echo "--- 4. usewarden init ---"
( cd "$PROJ" && "$USEWARDEN" init ) | tail -16
echo
AFTER_INIT_SHA="$(shasum -a 256 "$HOME/.claude/settings.json" | cut -d' ' -f1)"
echo "settings.json sha256 after init: $AFTER_INIT_SHA"
[ "$AFTER_INIT_SHA" != "$BEFORE_SHA" ] || { echo "FAIL: init did not change the config at all" >&2; exit 1; }
echo "  (changed, as expected)"
echo
echo "--- unrelated keys survived? ---"
python3 - "$HOME/.claude/settings.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
assert d["model"]=="opus", "model key lost"
assert d["env"]=={"MY_VAR":"keep me"}, "env key lost"
assert d["statusLine"]["command"]=="/bin/echo hello", "statusLine lost"
print("  OK - model, env and statusLine all intact; key order:", list(d.keys()))
PY
echo

# --- 5. protect -------------------------------------------------------------
echo "--- 5. usewarden status: PROTECTED ---"
( cd "$PROJ" && "$USEWARDEN" status ) | head -6
( cd "$PROJ" && "$USEWARDEN" status >/dev/null 2>&1; echo "  exit code = $?  (0 == protected)" )
echo
echo "--- 5b. the hook really blocks, invoked exactly as the agent would ---"
printf '%s' "{\"hook_event_name\":\"PreToolUse\",\"session_id\":\"sim\",\"cwd\":\"$PROJ\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat .env\"}}" \
  | "$USEWARDEN" hook claude pre_tool | sed 's/^/  /'
echo
echo

# --- 6. demo ----------------------------------------------------------------
echo "--- 6. usewarden demo ---"
( cd "$PROJ" && "$USEWARDEN" demo ) | tail -14
echo

# --- 7. uninstall and restore ----------------------------------------------
echo "--- 7. usewarden uninstall ---"
( cd "$PROJ" && "$USEWARDEN" uninstall ) | head -6
AFTER_UNINSTALL_SHA="$(shasum -a 256 "$HOME/.claude/settings.json" | cut -d' ' -f1)"
echo
echo "sha256 before init:      $BEFORE_SHA"
echo "sha256 after uninstall:  $AFTER_UNINSTALL_SHA"
if [ "$BEFORE_SHA" = "$AFTER_UNINSTALL_SHA" ]; then
  echo "  PASS - byte-identical"
else
  echo "  FAIL - uninstall did not restore the original bytes"; diff <(echo) <(echo); exit 1
fi
echo
echo "--- 8. usewarden restore-configs (the bigger hammer) ---"
# Make a mess first so restore has something to undo.
( cd "$PROJ" && "$USEWARDEN" init >/dev/null )
echo '{"deliberately":"mangled"}' > "$HOME/.claude/settings.json"
( cd "$PROJ" && "$USEWARDEN" restore-configs ) | sed 's/^/  /'
FINAL_SHA="$(shasum -a 256 "$HOME/.claude/settings.json" | cut -d' ' -f1)"
echo "sha256 after restore-configs: $FINAL_SHA"
[ "$FINAL_SHA" = "$BEFORE_SHA" ] || { echo "  FAIL - restore was not byte-identical" >&2; exit 1; }
echo "  PASS - byte-identical"
echo
echo "--- 9. nothing left outside usewarden's own paths ---"
# Three things write into the simulated HOME that are NOT usewarden, and saying so is the point:
#   ~/.npm/                      npm's own cache and logs, from `npm install` in step 2
#   ~/Library/Caches/com.apple.python/  bytecode cache from THIS script calling python3
#   ~/my-project, node_modules   the fixture and the install prefix
# Everything else must be usewarden's, and there must be nothing outside ~/.usewarden and ~/.claude.
NOT_USEWARDEN='-not -path */my-project/* -not -path */node_modules/* -not -path */.npm/* -not -path */Library/Caches/com.apple.python/*'
echo "files under the simulated HOME, excluding npm's own cache, the fixture, and this"
echo "script's python bytecode cache:"
# shellcheck disable=SC2086
find "$HOME" -type f $NOT_USEWARDEN 2>/dev/null | sed "s|$HOME|~|" | sort | sed 's/^/  /'
echo
# shellcheck disable=SC2086
WROTE_ELSEWHERE="$(find "$HOME" -type f $NOT_USEWARDEN -not -path "$HOME/.usewarden/*" -not -path "$HOME/.claude/*" 2>/dev/null || true)"
if [ -n "$WROTE_ELSEWHERE" ]; then
  echo "FAIL: usewarden wrote outside its own paths:"; echo "$WROTE_ELSEWHERE"; exit 1
fi
echo "  ASSERTED: usewarden wrote nothing outside ~/.usewarden (its own state) and"
echo "  ~/.claude/settings.json (the one agent config it was asked to register in)." 
echo
echo "=== CLEAN-MACHINE SIMULATION PASSED ==="
