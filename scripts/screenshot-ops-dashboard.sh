#!/usr/bin/env bash
# Renders the FOUNDER'S ops dashboard (npm run dashboard:web, ops/dashboard/src/web.ts) in a real
# browser, in both modes, at both widths, and saves PNGs to verification/.
#
# NOT the same page as scripts/screenshot.sh. That one shoots the PRODUCT's local dashboard - the
# token-protected one shipped inside the CLI (src/dashboard.ts) for people who install usewarden.
# This one shoots the private ops page that only exists in this repo. They are different servers on
# different ports with different content, and confusing them produced four byte-identical
# screenshots once already.
#
# VERIFY BY LOOKING (CLAUDE.md section 4.1): presentation mode is the view that gets shown to
# another human being, so it is checked by looking at rendered pixels, not by trusting that a CSS
# rule did what it says.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
OUT="$REPO/verification"
PORT="${PORT:-7799}"
mkdir -p "$OUT"

# One shared resolver, four consumers - see D-234 and scripts/resolve-browser.sh. Sourcing it is
# UNCONDITIONAL: a preset SHELL_BIN is honoured by the resolver and fenced identically, and the
# first version of this line only sourced the file when SHELL_BIN was unset - so an override
# skipped the fence entirely, which is the one case the fence exists for.
. "$REPO/scripts/resolve-browser.sh"
usewarden_resolve_browser "$REPO" || exit 1

npm run build --silent >/dev/null
PROFILE="$(mktemp -d)"
node "$REPO/dist/ops/dashboard/src/web.js" "$PORT" >/dev/null 2>&1 &
DASH_PID=$!
trap 'kill "$DASH_PID" 2>/dev/null || true; rm -rf "$PROFILE"' EXIT

URL="http://127.0.0.1:$PORT/"
for _ in $(seq 1 60); do
  curl -fsS --max-time 2 "$URL" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS --max-time 5 "$URL" >/dev/null || { echo "FAIL: dashboard did not come up on $PORT" >&2; exit 1; }
echo "dashboard: $URL"

shoot() {
  local name="$1" size="$2" query="${3:-}"
  "$SHELL_BIN" --headless --disable-gpu --hide-scrollbars --no-sandbox \
    --user-data-dir="$PROFILE/$name" \
    --window-size="$size" --virtual-time-budget=4000 \
    --screenshot="$OUT/$name.png" "$URL$query" >/dev/null 2>&1
  [ -s "$OUT/$name.png" ] || { echo "FAIL: $name.png was not produced" >&2; return 1; }
  echo "  $name.png  $(python3 -c "
import struct
d=open('$OUT/$name.png','rb').read(33)
w,h=struct.unpack('>II', d[16:24])
print(f'{w}x{h}', len(open('$OUT/$name.png','rb').read()), 'bytes')
")"
}

echo "screenshots:"
shoot ops-founder-desktop 1440,2200 '?mode=founder'
shoot ops-present-desktop 1440,2200 '?mode=present'
shoot ops-founder-laptop  1280,1800 '?mode=founder'
shoot ops-present-laptop  1280,1800 '?mode=present'

# The two modes MUST differ. Identical bytes mean the mode never applied and the screenshots prove
# nothing - which is exactly how the first attempt at this failed.
for w in desktop laptop; do
  if cmp -s "$OUT/ops-founder-$w.png" "$OUT/ops-present-$w.png"; then
    echo "FAIL: founder and present are byte-identical at $w - the mode did not apply" >&2
    exit 1
  fi
done
echo "  modes differ at both widths: OK"
echo "done -> $OUT"
