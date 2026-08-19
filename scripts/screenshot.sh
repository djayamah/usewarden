#!/usr/bin/env bash
# Renders the usewarden dashboard with a real headless browser and saves PNGs to verification/.
#
# VERIFY BY LOOKING (SPEC-BUILD.md section 5): a dashboard is verified by a rendered screenshot,
# not by asserting that a function returned some HTML.
#
# Uses a chrome-headless-shell that is already on this machine. Deliberately NOT a puppeteer or
# playwright devDependency: those ship postinstall scripts that download a browser, which is the
# exact install-script surface usewarden's own threat model (T-01) refuses.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
OUT="$REPO/verification"
mkdir -p "$OUT"

# SHELL_BIN and SHOT_CWD can be supplied by the caller. scripts/screenshot-synthetic.sh resolves
# the browser against the REAL home directory and then runs the dashboard under a synthetic one,
# so that the rendered page contains no real account name; without these two overrides that is
# impossible, because the browser lookup and the page content need different homes.
SHELL_BIN="${SHELL_BIN:-}"
[ -n "$SHELL_BIN" ] && [ -x "$SHELL_BIN" ] || for c in \
  "$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1194/chrome-mac/chrome-headless-shell" \
  "$(command -v chrome-headless-shell || true)" \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
  [ -n "$c" ] && [ -x "$c" ] && { SHELL_BIN="$c"; break; }
done
[ -n "$SHELL_BIN" ] || { echo "FAIL: no headless browser found. Screenshots CANNOT be produced." >&2; exit 1; }
echo "browser: $SHELL_BIN"

export USEWARDEN_HOME="${USEWARDEN_HOME:-$REPO/.usewarden-live}"
PROFILE="$(mktemp -d)"
trap 'rm -rf "$PROFILE"' EXIT

# Start the dashboard and read the tokenised URL off its own stdout.
DASH_LOG="$(mktemp)"
( cd "${SHOT_CWD:-$REPO}" && node "$REPO/dist/src/cli.js" dashboard --json ) > "$DASH_LOG" 2>&1 &
DASH_PID=$!
trap 'kill "$DASH_PID" 2>/dev/null || true; rm -rf "$PROFILE" "$DASH_LOG"' EXIT

for _ in $(seq 1 50); do
  URL="$(python3 -c "
import json,sys
try:
    print(json.load(open('$DASH_LOG'))['url'])
except Exception:
    pass
" 2>/dev/null)"
  [ -n "${URL:-}" ] && break
  sleep 0.2
done
[ -n "${URL:-}" ] || { echo "FAIL: dashboard did not report a URL" >&2; cat "$DASH_LOG" >&2; exit 1; }
echo "dashboard: ${URL%%\?*}?t=<redacted>"

# A headless browser ignores --force-dark-mode for prefers-color-scheme, so the page takes an
# explicit ?theme= override. Without it the "dark" and "light" screenshots came out
# byte-identical, which would have been a screenshot that proved nothing.
shoot() {
  local name="$1"; local size="$2"; local theme="$3"
  "$SHELL_BIN" --headless --disable-gpu --hide-scrollbars --no-sandbox \
    --user-data-dir="$PROFILE/$name" \
    --window-size="$size" --virtual-time-budget=3000 \
    --screenshot="$OUT/$name.png" "$URL&theme=$theme" >/dev/null 2>&1
  [ -s "$OUT/$name.png" ] || { echo "FAIL: $name.png was not produced" >&2; return 1; }
  echo "  $name.png  $(python3 -c "
import struct
d=open('$OUT/$name.png','rb').read(33)
w,h=struct.unpack('>II', d[16:24])
print(f'{w}x{h}', len(open('$OUT/$name.png','rb').read()), 'bytes')
")"
}

echo "screenshots:"
shoot dashboard-dark   1280,1600 dark
shoot dashboard-light  1280,1600 light
shoot dashboard-narrow 420,1500  dark

kill "$DASH_PID" 2>/dev/null || true
wait "$DASH_PID" 2>/dev/null || true
echo "done -> $OUT"
