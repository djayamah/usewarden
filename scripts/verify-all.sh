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

# A gate that depends on something outside this machine has THREE outcomes, not two, and
# collapsing them is how a suite starts lying. "I looked and it is fine" and "I could not look"
# are different sentences (CLAUDE.md section 4.4), and a network gate that reports PASS when the
# network is down is strictly worse than not having the gate: it manufactures a green.
#
# Convention: exit 3 means UNVERIFIED. It does not fail the run - an offline machine should still
# be able to build and test - but it DOES remove the words "ALL GATES GREEN" from the summary and
# is counted there by name. The run is green except for what nobody could see, and it says so.
UNVERIFIED=0
UNVERIFIED_NAMES=""
netgate() {
  local name="$1"; shift
  local out rc
  out="$("$@" 2>&1)"; rc=$?
  case $rc in
    0) printf 'PASS  %s\n' "$name" ;;
    3) printf 'UNVERIFIED  %s\n' "$name"
       printf '%s\n' "$out" | tail -6 | sed 's/^/        /'
       UNVERIFIED=$((UNVERIFIED+1)); UNVERIFIED_NAMES="$UNVERIFIED_NAMES
    - $name" ;;
    *) printf 'FAIL  %s  (exit %d)\n' "$name" "$rc"
       printf '%s\n' "$out" | tail -30 | sed 's/^/        /'
       FAILED=1 ;;
  esac
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
# `npm run build`, not a bare `tsc`. The build does more than compile - it also sets the execute
# bit on the CLI, without which a global install answers every command with "permission denied"
# (D-115). A gate that runs a DIFFERENT build command from the one users run is not verifying the
# build; it verified a bare tsc for months and never once exercised the step that matters.
gate "npm run build (strict, noUncheckedIndexedAccess)" npm run build
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

# THE SAME GATES CI RUNS, RUN HERE TOO.
#
# This script used to say ALL GATES GREEN while never invoking the scanner at all, and CI ran the
# scanner and went red. Both statements were true and they described different gates, so neither
# number meant anything. A local pass and a CI pass now check the same things; if one goes red the
# other does too, which is the only way either is worth reading.
echo
echo "--- the scan gates CI runs (identical invocations) ---"
gate "no credential in the working tree"   ./scripts/pre-public-scan.sh --scope=tree --classes=credentials
gate "publication rehearsal scans clean"   ./scripts/publish-rehearsal.sh

# Does every label, environment, reviewer and team named in .github/ actually exist on the
# repository the config runs in? `dependabot.yml` named `dependencies`, that label did not exist,
# and GitHub's documented response is to ignore it silently - so four Dependabot PRs sat open and
# unlabelled for three weeks with nothing anywhere saying why (D-231). A netgate, not a gate: the
# existence half needs GitHub, and "I could not look" is not "it is fine" (CLAUDE.md §4.4).
netgate "every label, environment and owner named in .github/ exists" \
  node ./scripts/check-config-references.mjs

# BOTH REPOSITORIES, AND FAILING RATHER THAN NARROWING.
#
# On 2026-09-08 a run swept the PUBLIC repository, found it green, and reported "all CI green"
# while the PRIVATE mirror - where every one of those commits landed first - had four failed runs
# and a `pages` workflow that had never once succeeded (D-273). The set of repositories comes from
# scripts/repos.txt cross-checked against the git remotes, and any disagreement is a hard failure:
# a sweep that quietly covers fewer repositories than the project has is the defect, not a partial
# pass.
netgate "every repository this project pushes to is healthy" \
  node ./scripts/repo-health.mjs

# ...and the one that looks BACKWARDS. Everything above asks whether the NEXT thing we ship is
# clean. This asks whether the thing we ALREADY shipped is clean, by fetching the public
# repository's current HEAD from GitHub and scanning its files. The two are different questions
# and for a while they had different answers (D-140, D-142).
#
# `--self-test` runs first and plants two identity strings in a copy of the published tree: if
# the scan does not BLOCK on that, the CLEAN it reports afterwards is worthless and the gate
# fails on the self-test rather than on the verdict.
netgate "the ALREADY-PUBLISHED head carries no identity string (fetched from GitHub, self-tested)" \
  ./scripts/scan-published-head.sh --self-test

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
# NOTE: these gates run against the machine's real agent configs on purpose. Isolating the agent
# home was tried and is wrong - agent DETECTION probes the agent home, so an empty one finds no
# agents at all and status correctly reports UNPROTECTED, proving nothing. The state directory
# `.usewarden-live` therefore has to know about every layer registered on this machine; if a gate
# here fails with "never registered hooks", run `usewarden init --yes` with USEWARDEN_HOME set to
# .usewarden-live and it will record the user layer alongside the fixture's project layer.
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
echo "--- metrics: derived, consistent, and uninflatable ---"
# A gate for the numbers themselves. `usewarden metrics` exits non-zero when its own arithmetic
# does not hold, so this runs it against a THROWAWAY state directory that has been deliberately
# filled with demo catches: the headline must still read zero.
MET_HOME="$(mktemp -d)"
if USEWARDEN_HOME="$MET_HOME" node dist/src/cli.js demo --json >/dev/null 2>&1 \
   && USEWARDEN_HOME="$MET_HOME" node dist/src/cli.js demo --json >/dev/null 2>&1; then
  MET_JSON="$(USEWARDEN_HOME="$MET_HOME" node dist/src/cli.js metrics --json 2>/dev/null || true)"
  MET_RC=$?
  LIVE_ATTEMPTS="$(printf '%s' "$MET_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["live"]["attempts"])' 2>/dev/null || echo "?")"
  DEMO_ATTEMPTS="$(printf '%s' "$MET_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["demo"]["attempts"])' 2>/dev/null || echo "?")"
  CONSISTENT="$(printf '%s' "$MET_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["integrity"]["consistent"])' 2>/dev/null || echo "?")"
  if [ "$LIVE_ATTEMPTS" = "0" ] && [ "$DEMO_ATTEMPTS" != "0" ] && [ "$DEMO_ATTEMPTS" != "?" ]; then
    printf 'PASS  two demo runs recorded %s blocks and moved the headline by %s\n' "$DEMO_ATTEMPTS" "$LIVE_ATTEMPTS"
  else
    printf 'FAIL  demo runs inflated the headline (live=%s demo=%s)\n' "$LIVE_ATTEMPTS" "$DEMO_ATTEMPTS"; FAILED=1
  fi
  if [ "$CONSISTENT" = "True" ]; then printf 'PASS  metrics integrity check holds (exit %s)\n' "$MET_RC"
  else printf 'FAIL  metrics integrity check reported %s\n' "$CONSISTENT"; FAILED=1; fi
else
  echo "FAIL  usewarden demo did not run against a throwaway state directory"; FAILED=1
fi
rm -rf "$MET_HOME"

echo
echo "--- documented counts match reality ---"
# The test count appears in README.md and FINAL-REPORT.md. Those numbers went stale three times
# during this build (197 -> 247 -> 324 -> 356) and nothing noticed, because a number in prose has
# nobody checking it. This is the check. It fails when the DOCS rot, never when the suite grows.
DOC_TESTS="$(grep -oE '# [0-9]+ tests, no network' README.md | grep -oE '[0-9]+' | head -1)"
REAL_TESTS="$(printf '%s' "$TEST_OUT" | grep -E "^(ℹ|# ) ?tests [0-9]+$" | grep -oE '[0-9]+' | head -1)"
if [ -n "$DOC_TESTS" ] && [ -n "$REAL_TESTS" ] && [ "$DOC_TESTS" = "$REAL_TESTS" ]; then
  printf 'PASS  README states %s tests and the suite runs %s\n' "$DOC_TESTS" "$REAL_TESTS"
else
  printf 'FAIL  README states %s tests, the suite runs %s - update the docs\n' "${DOC_TESTS:-?}" "${REAL_TESTS:-?}"
  FAILED=1
fi

echo
echo "--- pre-push guard (CLAUDE.md section 7, exception 1) ---"
if ./scripts/install-git-hooks.sh 2>&1 | sed 's/^/  /'; then
  echo "PASS  the public repository cannot be pushed to"
else
  echo "FAIL  the pre-push guard is not installed or not proven"; FAILED=1
fi

echo
echo "--- support bot: the eval set and the scope document ---"
BOT_JSON="$(node --input-type=module -e "
import {Corpus} from './dist/bots/triage/src/corpus.js';
import {runEval,runEndToEnd} from './dist/bots/triage/src/eval.js';
const c=new Corpus(process.cwd());
const a=runEval(c), b=runEndToEnd(c);
console.log(JSON.stringify({retrieval:[a.filter(x=>x.passed).length,a.length],e2e:[b.filter(x=>x.passed).length,b.length]}));
" 2>/dev/null | tail -1)"
R_PASS="$(printf '%s' "$BOT_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["retrieval"][0], d["retrieval"][1])' 2>/dev/null || echo '? ?')"
E_PASS="$(printf '%s' "$BOT_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["e2e"][0], d["e2e"][1])' 2>/dev/null || echo '? ?')"
if [ "${R_PASS% *}" = "${R_PASS#* }" ] && [ "${E_PASS% *}" = "${E_PASS#* }" ] && [ "${R_PASS% *}" != "?" ]; then
  printf 'PASS  support-bot eval: retrieval %s, end-to-end %s\n' "$R_PASS" "$E_PASS"
else
  printf 'FAIL  support-bot eval: retrieval %s, end-to-end %s\n' "$R_PASS" "$E_PASS"; FAILED=1
fi
if [ -s ops/BOT-SCOPE.md ] && grep -q 'Blast radius' ops/BOT-SCOPE.md; then
  echo "PASS  ops/BOT-SCOPE.md documents the blast radius"
else
  echo "FAIL  ops/BOT-SCOPE.md missing or does not document the blast radius"; FAILED=1
fi

echo
echo "--- built but NOT deployed ---"
# service/ and site/ are deliberately inert. This asserts the inertness rather than trusting it.
# Look for deploy FILES by name, and for deploy COMMANDS in anything that is not prose.
# The first version of this gate grepped for the words and tripped over service/README.md, which
# says in plain English that there is no Dockerfile and no Terraform. A gate that fails on a
# document promising the thing it is checking for is a gate people learn to ignore.
DEPLOY_FILES="$(find service site .github -type f \
  \( -iname 'Dockerfile*' -o -iname 'docker-compose*' -o -iname 'fly.toml' -o -iname 'vercel.json' \
     -o -iname 'netlify.toml' -o -iname 'render.yaml' -o -iname 'app.yaml' -o -iname '*.tf' \
     -o -iname 'Procfile' -o -iname 'k8s*.yaml' \) 2>/dev/null)"
DEPLOY_CMDS="$(grep -rlniE '(^|[^[:alnum:]])(kubectl|terraform apply|flyctl deploy|vercel --prod|netlify deploy|docker push)' \
  --include='*.yml' --include='*.yaml' --include='*.sh' --include='*.ts' --include='*.js' --include='*.json' \
  service site .github 2>/dev/null)"
if [ -n "$DEPLOY_FILES" ] || [ -n "$DEPLOY_CMDS" ]; then
  echo "FAIL  a deploy artifact appeared under service/, site/ or .github/:"
  printf '%s\n' "$DEPLOY_FILES" "$DEPLOY_CMDS" | sed '/^$/d;s/^/        /'
  FAILED=1
else
  echo "PASS  no deploy artifact for the service or the site"
fi
if grep -qE "USEWARDEN_TELEMETRY_ENDPOINT\s*=\s*['\"]?https" src/*.ts 2>/dev/null; then
  echo "FAIL  a default telemetry endpoint is baked into the client"; FAILED=1
else
  echo "PASS  the client ships no telemetry endpoint"
fi

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
  docs/METRICS.md docs/BOT-COSTS.md service/README.md site/README.md site/index.html
  ops/BOT-SCOPE.md ops/DASHBOARD.md ops/X-BOT-SETUP.md
  launch/HN-COMMENT-PREP.md launch/REDDIT-PRESENCE.md launch/DISCOVERABILITY.md
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
if [ $FAILED -ne 0 ]; then
  echo "=== FULL VERIFICATION PASS: FAILURES ABOVE ==="
elif [ $UNVERIFIED -ne 0 ]; then
  # Deliberately NOT the words "ALL GATES GREEN". Every gate that ran passed, and $UNVERIFIED of
  # them could not run. Reporting that as green is the failure mode this project exists to stop.
  echo "=== FULL VERIFICATION PASS: every gate that COULD run is green; $UNVERIFIED UNVERIFIED ==="
  printf '    unverified:%s\n' "$UNVERIFIED_NAMES"
  echo "    These were not checked. Re-run with network access before relying on this pass."
else
  echo "=== FULL VERIFICATION PASS: ALL GATES GREEN ==="
fi
exit $FAILED
