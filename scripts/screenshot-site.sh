#!/usr/bin/env bash
# Renders site/index.html with a real headless browser and saves PNGs to verification/.
#
# VERIFY BY LOOKING (SPEC-BUILD.md section 5). tests/site.test.ts asserts the page's PROPERTIES -
# that it fetches nothing, runs no script, and that its factual claims still match the repo. That
# is not the same as the page being legible, and a test suite cannot tell you that the incident
# card renders as a card rather than as a stack of unstyled definition lists.
#
# The page is a local file with no server: it is loaded over file://, which is also the only way
# anyone will ever look at it, since it is not deployed (site/README.md).
#
# Uses a chrome-headless-shell already on this machine. Deliberately NOT a puppeteer/playwright
# devDependency: those ship postinstall scripts that download a browser, which is the exact
# install-script surface usewarden's own threat model (T-01) refuses.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
OUT="$REPO/verification"
PAGE="$REPO/site/index.html"
mkdir -p "$OUT"

[ -f "$PAGE" ] || { echo "FAIL: $PAGE does not exist" >&2; exit 1; }

# One shared resolver, four consumers - see D-234 and scripts/resolve-browser.sh. Sourcing it is
# UNCONDITIONAL: a preset SHELL_BIN is honoured by the resolver and fenced identically, and the
# first version of this line only sourced the file when SHELL_BIN was unset - so an override
# skipped the fence entirely, which is the one case the fence exists for.
. "$REPO/scripts/resolve-browser.sh"
usewarden_resolve_browser "$REPO" || exit 1

PROFILE="$(mktemp -d)"
trap 'rm -rf "$PROFILE"' EXIT

shoot() {
  local name="$1"; local size="$2"; shift 2
  "$SHELL_BIN" --headless --disable-gpu --hide-scrollbars --no-sandbox \
    --user-data-dir="$PROFILE/$name" \
    --window-size="$size" --virtual-time-budget=3000 "$@" \
    --screenshot="$OUT/$name.png" "file://$PAGE" >/dev/null 2>&1
  [ -s "$OUT/$name.png" ] || { echo "FAIL: $name.png was not produced" >&2; return 1; }
  echo "  $name.png  $(python3 -c "
import struct
d=open('$OUT/$name.png','rb').read(33)
w,h=struct.unpack('>II', d[16:24])
print(f'{w}x{h}', len(open('$OUT/$name.png','rb').read()), 'bytes')
")"
}

# --force-dark-mode does NOT move prefers-color-scheme in a headless shell: it produced two
# byte-identical PNGs, which is a screenshot that proves nothing. The blink setting does move it
# (measured: 88,085 vs 87,254 bytes on the same page), so that is what is used, and the sizes
# below are checked afterwards to make sure the two renders really did differ.
echo "screenshots:"
shoot site-light  1280,2400 --blink-settings=preferredColorScheme=1
shoot site-dark   1280,2400 --blink-settings=preferredColorScheme=0
shoot site-narrow 400,2000  --blink-settings=preferredColorScheme=0

if cmp -s "$OUT/site-light.png" "$OUT/site-dark.png"; then
  echo "FAIL: the light and dark renders are byte-identical - the theme override did not apply" >&2
  exit 1
fi
echo "  light and dark renders differ (the theme override applied)"

echo "done -> $OUT"
