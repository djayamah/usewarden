# shellcheck shell=bash
# THE ONE PLACE THAT DECIDES WHICH BROWSER RENDERS A SCREENSHOT.
#
# WHY THIS FILE EXISTS (D-234)
#   `scripts/screenshot.sh` resolved a headless browser from the shared playwright cache. That
#   directory is not a browser: every file in it is a SYMLINK whose target is under
#   `~/Documents/REDACTED-video/` — a path CLAUDE.md §1 forbids twice over, once as `~/Documents/`
#   and once as *any path containing `REDACTED`, in any case*. Every screenshot this repository has
#   produced executed a binary out of the operator's private directories, and nothing said so,
#   because the path that was CHECKED was the link and the path that was USED was its target.
#   `[ -x "$c" ]` follows a symlink and reports success. §1 says it in as many words: *a symlink is
#   not a fence*.
#
#   Fixing that in one script left three others still doing it — four copies of the same candidate
#   list, one of them corrected. That is the drift `scripts/internal-only-paths.txt` exists to
#   prevent, repeating itself on the same day in the same run. So the list lives here, once, and the
#   four consumers source it.
#
# CONTRACT
#   Sets and exports SHELL_BIN. Exits non-zero, loudly, if the only browser available resolves into
#   a forbidden path — a screenshot gate that silently reaches into private directories is worse
#   than one that does not run, and "could not verify" is a failure, not a pass (CLAUDE.md §4.4).
#
#   Callers must set REPO before sourcing. `SHELL_BIN` set in the environment is honoured, and is
#   fenced exactly the same way: an override is not an exemption.

usewarden_resolve_browser() {
  local repo="${1:?resolve-browser: REPO is required}"

  # The repo-local browser first. It is inside the fence by construction. Install it with:
  #   npm_config_cache="$repo/.npm-cache" PLAYWRIGHT_BROWSERS_PATH="$repo/.browsers" \
  #     npx --yes playwright@latest install chromium-headless-shell
  #
  # Both directories live inside the repository on purpose: a write outside `~/dev/warden` is not
  # authorised (CLAUDE.md §3), and the shared npm cache holds root-owned files whose documented fix
  # is `sudo`, which is forbidden outright.
  if [ -z "${SHELL_BIN:-}" ] || [ ! -x "${SHELL_BIN:-}" ]; then
    local c
    for c in \
      "$(ls -d "$repo"/.browsers/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell 2>/dev/null | tail -1)" \
      "$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1194/chrome-mac/chrome-headless-shell" \
      "$(command -v chrome-headless-shell || true)" \
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
      [ -n "$c" ] && [ -x "$c" ] && { SHELL_BIN="$c"; break; }
    done
  fi

  if [ -z "${SHELL_BIN:-}" ]; then
    echo "FAIL: no headless browser found. Screenshots CANNOT be produced." >&2
    echo "      Install one inside the repository:" >&2
    echo "        npm_config_cache=\"\$PWD/.npm-cache\" PLAYWRIGHT_BROWSERS_PATH=\"\$PWD/.browsers\" \\" >&2
    echo "          npx --yes playwright@latest install chromium-headless-shell" >&2
    return 1
  fi

  # RESOLVE, then judge. This is the whole point of the file.
  local real
  real="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$SHELL_BIN" 2>/dev/null || echo "$SHELL_BIN")"
  case "$real" in
    *REDACTED*|*REDACTED*|*REDACTED*|*REDACTED*|"$HOME"/Documents/*)
      echo "FAIL: the headless browser at" >&2
      echo "        $SHELL_BIN" >&2
      echo "      resolves to" >&2
      echo "        $real" >&2
      echo "      which is inside a path CLAUDE.md §1 forbids. REFUSING to run it." >&2
      echo "      Install one inside the repository instead:" >&2
      echo "        npm_config_cache=\"\$PWD/.npm-cache\" PLAYWRIGHT_BROWSERS_PATH=\"\$PWD/.browsers\" \\" >&2
      echo "          npx --yes playwright@latest install chromium-headless-shell" >&2
      return 1 ;;
  esac

  export SHELL_BIN
  echo "browser: $SHELL_BIN"
  [ "$real" != "$SHELL_BIN" ] && echo "  resolves to: $real"
  return 0
}
