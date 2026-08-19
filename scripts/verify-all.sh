#!/usr/bin/env bash
# FULL VERIFICATION PASS (Phase 9).
# Runs every gate from a clean build, on BOTH the build machine's Node and the LTS target,
# and prints a pass/fail line for each. Exits non-zero if anything fails.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$REPO"
export NO_COLOR=1
FAILED=0

gate() {
  local name="$1"; shift
  local out rc
  out="$("$@" 2>&1)"; rc=$?
  if [ $rc -eq 0 ]; then
    printf 'PASS  %s\n' "$name"
  else
    printf 'FAIL  %s  (exit %d)\n' "$name" "$rc"
    printf '%s\n' "$out" | tail -20 | sed 's/^/        /'
    FAILED=1
  fi
}

# Usage: ./scripts/verify-all.sh > /tmp/pass.txt 2>&1 && cp /tmp/pass.txt verification/
# Redirecting straight into verification/ would create an untracked file and make the
# pre-publish check's clean-tree assertion fail against this script's own output.
echo "=== USEWARDEN FULL VERIFICATION PASS ==="
echo "captured: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "commit:   $(git rev-parse HEAD)"
echo "branch:   $(git rev-parse --abbrev-ref HEAD)"
echo "node:     $(node --version)   npm: $(npm --version)"
echo

echo "--- clean build from scratch ---"
rm -rf dist
gate "typescript build (strict, noUncheckedIndexedAccess)" npx tsc -p tsconfig.json
gate "typecheck with no emit"                              npx tsc -p tsconfig.json --noEmit

echo
echo "--- test suite, build machine ---"
TEST_OUT="$(npm test 2>&1)"
echo "$TEST_OUT" | grep -E '^(ℹ|# ) ?(tests|suites|pass|fail)' | sed 's/^/  /'
# A HERE-STRING, not a pipe. Under `set -o pipefail`, `producer | grep -q PATTERN` reports the
# pipeline as FAILED whenever grep finds its match and exits before the producer has finished
# writing: the producer takes SIGPIPE, exits 141, and pipefail promotes that to the pipeline's
# status. With ~1,900 lines of TAP and the match on the second-to-last line, that is a race - it
# reported "FAIL full suite (exit 0)" for a suite that had just passed 247/247, twice. A gate that
# intermittently fails a passing run is worse than no gate, because the first response is to
# re-run it until it goes green.
if grep -qE '^(ℹ|# ) ?fail 0$' <<<"$TEST_OUT"; then
  echo "PASS  full suite on $(node --version)"
else
  echo "FAIL  full suite on $(node --version)"; FAILED=1
fi
echo "$TEST_OUT" | grep -E 'Layer-1 catch rate|missed \(expected' | sed 's/^/  /'

echo
echo "--- test suite, LTS target (Node 22) ---"
N22=/opt/homebrew/opt/node@22/bin/node
if [ -x "$N22" ]; then
  LTS_OUT="$("$N22" --test "dist/tests/**/*.test.js" 2>&1)"; LTS_RC=$?
  echo "$LTS_OUT" | grep -E '^# (tests|pass|fail)' | sed 's/^/  /'
  # Trust the runner's EXIT STATUS as the authority and the summary line as corroboration.
  # Relying on the text alone once produced a spurious FAIL on a run whose summary said
  # `# fail 0`, which is the same "reported state disagrees with reality" trap this project
  # keeps finding elsewhere.
  if [ $LTS_RC -eq 0 ] && grep -qE '^# fail 0$' <<<"$LTS_OUT"; then
    echo "PASS  full suite on $("$N22" --version) (Active LTS)"
  else
    echo "FAIL  full suite on $("$N22" --version) (exit $LTS_RC)"
    grep -E "not ok|AssertionError" <<<"$LTS_OUT" | head -10 | sed 's/^/        /' || true
    FAILED=1
  fi
else
  echo "SKIP  no node@22 on this machine - the LTS target was NOT verified"
  FAILED=1
fi

echo
# The pre-publish check asserts a CLEAN working tree, so it runs before the gates below
# regenerate the fixture and re-render the screenshots. Redirect THIS script's own output to a
# temp file and copy it in at the end, or the redirect itself dirties the tree it is checking.
echo "--- pre-publish check (runs first: it requires a clean working tree) ---"
gate "pre-publish check" ./scripts/pre-publish-check.sh

echo
echo "--- fixture is reproducible from the tracked seed ---"
gate "scripts/make-fixture.sh regenerates the sabotage fixture" ./scripts/make-fixture.sh
# Regenerating the fixture wipes its project-level agent configs, so usewarden has to be
# re-registered before the CLI smoke tests below can meaningfully report PROTECTED.
export USEWARDEN_HOME="$REPO/.usewarden-live"
gate "usewarden re-registers in the regenerated fixture" bash -c 'cd fixtures/sandbox-project && node ../../dist/src/cli.js init --project >/dev/null'

echo
echo "--- end-to-end gates ---"
gate "clean-machine simulation (pack -> install -> protect -> demo -> uninstall -> restore)" ./scripts/clean-machine-sim.sh
# The SYNTHETIC capture is the one whose PNGs are committed and published: it renders the real
# captured incidents under a throwaway HOME so the images carry no account name. Running the raw
# scripts/screenshot.sh here would silently overwrite them with ones that do.
gate "dashboard screenshots rendered by a real headless browser (synthetic home)"           ./scripts/screenshot-synthetic.sh

echo
echo "--- CLI smoke, against the live fixture state ---"
gate "usewarden --version" node dist/src/cli.js --version
gate "usewarden status"    bash -c 'cd fixtures/sandbox-project && node ../../dist/src/cli.js status >/dev/null'
gate "usewarden doctor"    bash -c 'cd fixtures/sandbox-project && node ../../dist/src/cli.js doctor >/dev/null'
gate "usewarden policy"    bash -c 'cd fixtures/sandbox-project && node ../../dist/src/cli.js policy >/dev/null'
gate "usewarden demo"      node dist/src/cli.js demo
gate "usewarden incidents --json" bash -c 'node dist/src/cli.js incidents --json >/dev/null'
gate "usewarden telemetry status" bash -c 'node dist/src/cli.js telemetry status >/dev/null'
gate "usewarden statusline" bash -c 'node dist/src/cli.js statusline </dev/null >/dev/null'

echo
echo "--- live evidence on record ---"
node dist/src/cli.js status --json | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f\"  live catches from real agent sessions: {d['liveCatches']} (requirement: >= 3)\")
print(f\"  metered judge spend: \${d['judge']['usd']:.4f} of \$15.00 limit\")
"
echo "  live session transcripts:"
ls -1 verification/live/*.txt | sed 's/^/    /'

echo
echo "--- documentation completeness ---"
# Split deliberately. The first list ships in the public repository and a fresh clone must have
# every one of them; the second list is the private build record, which the publication tree
# excludes on purpose (scripts/build-publish-tree.sh). Requiring the second list unconditionally
# would make this script fail for any contributor who ran it, which is a check that trains people
# to ignore it.
PUBLIC_DOCS="README.md SECURITY.md LICENSE CONTRIBUTING.md DECISIONS.md
  .github/workflows/ci.yml .github/workflows/release.yml .github/pull_request_template.md
  .github/ISSUE_TEMPLATE/bug_report.yml .github/ISSUE_TEMPLATE/agent_support.yml
  assets/incident-card.png assets/dashboard.png
  docs/HOOK-MATRIX.md docs/THREAT-MODEL.md docs/DEPENDENCY-BUDGET.md docs/TELEMETRY.md
  ops/JUDGE-LIVE-CHECK.md"
INTERNAL_DOCS="CLAUDE.md PROGRESS.md launch/NAME-CANDIDATES.md launch/POSTS.md
  launch/PUBLISH-CHECKLIST.md launch/RULES-REGISTRY.md"

for f in $PUBLIC_DOCS; do
  if [ -s "$f" ]; then printf 'PASS  %s (%s lines)\n' "$f" "$(wc -l < "$f" | tr -d ' ')"
  else printf 'FAIL  %s missing or empty\n' "$f"; FAILED=1; fi
done
for f in $INTERNAL_DOCS; do
  if [ -s "$f" ]; then printf 'PASS  %s (%s lines)\n' "$f" "$(wc -l < "$f" | tr -d ' ')"
  else printf 'SKIP  %s absent - internal build record, not part of a public checkout\n' "$f"; fi
done
echo
if grep -n "PENDING" docs/THREAT-MODEL.md | grep -qv "says \`PENDING\`\|no PENDING rows"; then
  echo "FAIL  docs/THREAT-MODEL.md still has a PENDING mitigation"; FAILED=1
else
  echo "PASS  every threat-model row names a real proving test"
fi

echo
if [ $FAILED -eq 0 ]; then
  echo "=== FULL VERIFICATION PASS: ALL GATES GREEN ==="
else
  echo "=== FULL VERIFICATION PASS: FAILURES ABOVE ==="
fi
exit $FAILED
