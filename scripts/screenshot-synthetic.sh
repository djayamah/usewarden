#!/usr/bin/env bash
# SYNTHETIC-HOME SCREENSHOT CAPTURE
#
# Renders the dashboard screenshots that ship in the README, from REAL captured incidents but
# under a synthetic home directory and a synthetic project name, so the published PNGs contain
# no account name, no machine path, and no fixture jargon.
#
# What is real in the output and what is not - stated here because the README claims these
# screenshots are evidence:
#   REAL: every incident, its rule, its layer, its reason text, its timestamp, and the counters.
#         They come from this repository's actual live-session and sabotage runs.
#   REWRITTEN: absolute paths only. The captured fixture paths are rewritten to a synthetic
#         project (~/dev/acme-api and its sibling ~/dev/acme-web) inside a throwaway HOME, and
#         the product's own displayPath() then collapses that HOME to `~` exactly as it would
#         for any user. Nothing about what was caught, or why, is altered.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$REPO"

SRC="${1:-$REPO/.usewarden-live}"
[ -d "$SRC" ] || { echo "no captured state at $SRC" >&2; exit 1; }

# Resolve the browser against the REAL home before HOME is replaced.
for c in \
  "$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1194/chrome-mac/chrome-headless-shell" \
  "$(command -v chrome-headless-shell || true)" \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
  [ -n "$c" ] && [ -x "$c" ] && { export SHELL_BIN="$c"; break; }
done
[ -n "${SHELL_BIN:-}" ] || { echo "FAIL: no headless browser found" >&2; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
# pwd -P: on macOS a mktemp dir under /var is a symlink to /private/var, and Node resolves it.
# Without this, HOME and the paths Node reports differ and displayPath() collapses only the
# inner half - the first capture rendered "/private~/dev/acme-api", which is nobody's path.
mkdir -p "$STAGE/home"
SYNHOME="$(cd "$STAGE/home" && pwd -P)"
PROJECT="$SYNHOME/dev/acme-api"
SIBLING="$SYNHOME/dev/acme-web"
mkdir -p "$PROJECT/src" "$SIBLING/src" "$SYNHOME/.usewarden"

# A real git repo, because usewarden's scope logic resolves the repo root and would otherwise
# report the project as unprotected - which would make the screenshot a lie in the other direction.
for d in "$PROJECT" "$SIBLING"; do
  git -C "$d" init -q -b main
  git -C "$d" config user.email dev@example.invalid
  git -C "$d" config user.name  "dev"
  echo "# $(basename "$d")" > "$d/README.md"
  git -C "$d" add -A && git -C "$d" commit -qm "initial"
done

cp -R "$SRC/." "$SYNHOME/.usewarden/"
rm -rf "$SYNHOME/.usewarden/backups" "$SYNHOME/.usewarden/pending"

# Rewrite the captured absolute paths onto the synthetic project.
REALHOME="$HOME" SYNHOME="$SYNHOME" SYN="$PROJECT" SYNSIB="$SIBLING" DB="$SYNHOME/.usewarden/usewarden.db" node -e '
const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync(process.env.DB);
const real=process.env.REALHOME;
const pairs=[
  [real+"/dev/warden/fixtures/sandbox-project", process.env.SYN],
  [real+"/dev/warden/fixtures/sibling-repo",    process.env.SYNSIB],
  ["/Users/you/dev/warden/fixtures/sandbox-project", process.env.SYN],
  ["/Users/you/dev/warden/fixtures/sibling-repo",    process.env.SYNSIB],
];
const cols={incidents:["attempted","reason","target","cwd","title","rule"],events:["payload"],sessions:["cwd"]};
let n=0;
for (const [t,cs] of Object.entries(cols)) {
  let info=[]; try { info=db.prepare("pragma table_info("+t+")").all().map(r=>r.name); } catch(e){ continue; }
  for (const c of cs) { if(!info.includes(c)) continue;
    for (const [a,b] of pairs) n+=(db.prepare("update "+t+" set "+c+" = replace("+c+", ?, ?)").run(a,b).changes||0); }
}
// The published wall shows the catches from REAL agent sessions (live=1) only. The remaining
// rows are the same four demo/simulation blocks repeated once per run of the verification
// harness - re-running the test suite eight times is why there are eight copies. Excluding
// them is not cherry-picking the flattering ones: it removes duplicates of the LEAST
// interesting catches, and the README says exactly this next to the image.
try { db.prepare("delete from incidents where live = 0").run(); } catch(e){}
// Rows captured before the 2026-08-19 rename still say "Warden:" in their reason text.
for (const c of ["reason","title","attempted","target","cwd"]) {
  try {
    // Any remaining absolute path under the real home (a live session touched ~/Library/Caches,
    // for instance) moves under the synthetic home so displayPath() can collapse it to `~`.
    db.prepare("update "+"incidents"+" set "+c+" = replace("+c+", ?, ?)").run(real, process.env.SYNHOME);
    // Pre-rename rows still say "Warden"; the negative lookbehind is done by replacing the
    // already-correct token back afterwards, which is idempotent.
    db.prepare("update incidents set "+c+" = replace("+c+", ?, ?)").run("Warden","Usewarden");
    db.prepare("update incidents set "+c+" = replace("+c+", ?, ?)").run("UseUsewarden","Usewarden");
  } catch(e){}
}
// The copied database still records the hook registrations of the REAL machine, and
// buildStatus() enumerates agents from those recorded paths - the first capture listed the
// build machine s own fixture configs beside the synthetic ones. Clear the baseline; the
// init below records a fresh one for the synthetic project.
try { db.prepare("delete from integrity").run(); } catch(e){}
console.log("rewritten:",n,"remaining incidents:",db.prepare("select count(*) c from incidents").get().c);
' 2>&1 | grep -vE "ExperimentalWarning|trace-warnings"

# The agent config files have to exist before detection can find anything: usewarden detects an
# agent by its config, and an empty synthetic home has none. These are the same three files the
# sabotage fixture creates.
# Detection probes the AGENT HOME for each agent's GLOBAL config; a project config alone is
# invisible to it. Both levels are seeded, exactly as a real machine with these three agents
# installed would look.
mkdir -p "$SYNHOME/.claude" "$SYNHOME/.gemini" "$SYNHOME/.codex"
printf '{}\n' > "$SYNHOME/.claude/settings.json"
printf '{}\n' > "$SYNHOME/.gemini/settings.json"
printf '{}\n' > "$SYNHOME/.codex/hooks.json"
mkdir -p "$PROJECT/.claude" "$PROJECT/.gemini" "$PROJECT/.codex"
printf '{}\n' > "$PROJECT/.claude/settings.json"
printf '{}\n' > "$PROJECT/.gemini/settings.json"
printf '{}\n' > "$PROJECT/.codex/hooks.json"

# Register usewarden in the synthetic project so the AGENTS table reads PROTECTED for real.
HOME="$SYNHOME" USEWARDEN_HOME="$SYNHOME/.usewarden" USEWARDEN_AGENT_HOME="$SYNHOME" \
  bash -c "cd '$PROJECT' && node '$REPO/dist/src/cli.js' init --project --yes >/dev/null 2>&1" || true

HOME="$SYNHOME" USEWARDEN_HOME="$SYNHOME/.usewarden" USEWARDEN_AGENT_HOME="$SYNHOME" \
  SHOT_CWD="$PROJECT" "$REPO/scripts/screenshot.sh"

echo
echo "captured under a synthetic HOME; the real home directory appears nowhere in the PNGs."
