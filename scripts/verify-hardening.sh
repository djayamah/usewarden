#!/usr/bin/env bash
# VERIFY HARDENING
#
# Queries the GitHub and npm APIs and prints a pass/fail row for every release-security control.
#
# THE RULE THIS SCRIPT IS BUILT AROUND:
#   It must NEVER report PASS for a control it could not actually check. A control whose state
#   is unknown is reported as UNVERIFIED and counted as a failure, because "I could not tell"
#   and "it is fine" are not the same sentence, and treating them as the same is how a hardening
#   report becomes decorative.
#
# Usage:
#   ./scripts/verify-hardening.sh                 # defaults to djayamah/usewarden
#   REPO=owner/name PKG=pkgname ./scripts/verify-hardening.sh
set -uo pipefail

REPO_SLUG="${REPO:-djayamah/usewarden}"
PKG="${PKG:-$(python3 -c "import json;print(json.load(open('package.json'))['name'])" 2>/dev/null || echo usewarden)}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"

PASS=0; FAIL=0; UNVERIFIED=0
VTMP="$(mktemp -d)"; trap 'rm -rf "$VTMP"' EXIT

row() { # row STATUS "control" "detail"
  printf '%-11s %-52s %s\n' "$1" "$2" "$3"
  case "$1" in
    PASS)       PASS=$((PASS+1)) ;;
    FAIL)       FAIL=$((FAIL+1)) ;;
    UNVERIFIED) UNVERIFIED=$((UNVERIFIED+1)) ;;
  esac
}

echo "=== USEWARDEN HARDENING VERIFICATION ==="
echo "captured:  $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "repo:      $REPO_SLUG"
echo "package:   $PKG"
echo "commit:    $(git rev-parse HEAD 2>/dev/null || echo '(no git)')"
echo
printf '%-11s %-52s %s\n' STATUS CONTROL DETAIL
printf '%-11s %-52s %s\n' "-----------" "----------------------------------------------------" "------"

# ---------------------------------------------------------------------------
# 0. Can we talk to GitHub at all? If not, EVERY GitHub row must be UNVERIFIED,
#    not silently skipped.
# ---------------------------------------------------------------------------
GH_OK=0
if ! command -v gh >/dev/null 2>&1; then
  row UNVERIFIED "gh CLI available" "gh not installed - no GitHub control can be checked"
elif ! gh auth status >/dev/null 2>&1; then
  row UNVERIFIED "gh CLI authenticated" "not logged in - no GitHub control can be checked"
else
  GH_OK=1
  row PASS "gh CLI available and authenticated" "$(gh --version | head -1)"
fi

gh_json() { # gh_json <api path> ; prints body, returns non-zero on failure
  gh api "$1" 2>/dev/null
}

# ---------------------------------------------------------------------------
# 1. Repository exists and is PRIVATE
# ---------------------------------------------------------------------------
if [ $GH_OK -eq 1 ]; then
  REPO_JSON="$(gh_json "repos/$REPO_SLUG")"
  if [ -z "$REPO_JSON" ]; then
    row UNVERIFIED "repository reachable" "GET repos/$REPO_SLUG returned nothing"
  else
    VIS="$(printf '%s' "$REPO_JSON" | python3 -c "import json,sys;print(json.load(sys.stdin).get('visibility'))")"
    # The founder took the decision to publish on 2026-08-19. Before that this row asserted
    # PRIVATE; it now asserts PUBLIC, because "public" is the intended state and a check that
    # still tested the old intent would report a FAIL for the thing that was supposed to happen.
    # It is also a precondition for the two controls GitHub Free refuses on private repos.
    if [ "$VIS" = "public" ]; then
      row PASS "repository is PUBLIC (intended since 2026-08-19)" "visibility=$VIS"
    else
      row FAIL "repository is PUBLIC" "visibility=$VIS - branch protection and required reviewers are unavailable on GitHub Free while it is private"
    fi
    DEFBR="$(printf '%s' "$REPO_JSON" | python3 -c "import json,sys;print(json.load(sys.stdin).get('default_branch'))")"
    row PASS "default branch identified" "$DEFBR"
  fi
else
  row UNVERIFIED "repository is PRIVATE" "GitHub unreachable"
fi

# ---------------------------------------------------------------------------
# 1b. Disclosure channel and secret scanning
#
#     Added 2026-08-20. Private vulnerability reporting was found DISABLED while SECURITY.md
#     already named it the preferred route, which meant the project had no working security
#     contact at all - a documented channel that does not exist is worse than an undocumented
#     one, because a reporter follows it and lands nowhere. Verified here so it cannot silently
#     revert.
# ---------------------------------------------------------------------------
if [ $GH_OK -eq 1 ]; then
  if PVR="$(gh api "repos/$REPO_SLUG/private-vulnerability-reporting" --jq .enabled 2>/dev/null)"; then
    [ "$PVR" = "true" ] \
      && row PASS "private vulnerability reporting ENABLED" "SECURITY.md names it as the whole disclosure channel" \
      || row FAIL "private vulnerability reporting ENABLED" "disabled, but SECURITY.md points reporters at it"
  else
    row UNVERIFIED "private vulnerability reporting" "endpoint unreadable with this token"
  fi

  if SA="$(gh api "repos/$REPO_SLUG" --jq '.security_and_analysis.secret_scanning.status + "/" + .security_and_analysis.secret_scanning_push_protection.status' 2>/dev/null)"; then
    case "$SA" in
      enabled/enabled) row PASS "secret scanning + push protection" "$SA" ;;
      *)               row FAIL "secret scanning + push protection" "$SA - push protection refuses a commit that CONTAINS a credential" ;;
    esac
  else
    row UNVERIFIED "secret scanning" "not readable with this token"
  fi

  # SECURITY.md must not ship a placeholder or an unrotatable personal address.
  if grep -q "SECURITY_CONTACT_PLACEHOLDER" "$ROOT/SECURITY.md" 2>/dev/null; then
    row FAIL "SECURITY.md has a real disclosure route" "the contact placeholder is still in the file"
  elif grep -qE "security/advisories/new" "$ROOT/SECURITY.md" 2>/dev/null; then
    row PASS "SECURITY.md has a real disclosure route" "links the private advisory form; publishes no email address"
  else
    row FAIL "SECURITY.md has a real disclosure route" "no advisory link found"
  fi
fi

# ---------------------------------------------------------------------------
# 2. Branch protection on the default branch
#    Checked BOTH ways: rulesets (current) and the legacy branch-protection API.
#    A 403 here on a private repo means the plan does not support it - that is a
#    real, reportable gap, not a pass.
# ---------------------------------------------------------------------------
if [ $GH_OK -eq 1 ]; then
  RS_RAW="$(gh api "repos/$REPO_SLUG/rulesets" 2>&1)"
  RS_RC=$?
  LEGACY_RAW="$(gh api "repos/$REPO_SLUG/branches/${DEFBR:-main}/protection" 2>&1)"
  LEGACY_RC=$?

  if [ $RS_RC -eq 0 ] && printf '%s' "$RS_RAW" | python3 -c "
import json,sys
rs=json.load(sys.stdin)
sys.exit(0 if isinstance(rs,list) and len(rs)>0 else 1)" 2>/dev/null; then
    RSID="$(printf '%s' "$RS_RAW" | python3 -c "import json,sys;print(json.load(sys.stdin)[0]['id'])")"
    RSD="$(gh api "repos/$REPO_SLUG/rulesets/$RSID" 2>/dev/null)"
    # The python goes into a FILE, not into `python3 -c "..."` inside `eval "$( ... )"`.
    # Nested double quotes inside a command substitution inside an eval are parsed differently
    # by bash 3.2 (which is what /bin/bash still is on macOS) and the set-comprehension braces
    # came out of it mangled - the block SyntaxError'd the first time this repository was
    # hardened for real, because until then no ruleset existed and this branch had never run.
    cat > "$VTMP/rs.py" <<'RSPY'
import json,sys
d=json.load(sys.stdin)
types={r['type'] for r in d.get('rules',[])}
print("RS_ENF=%s" % d.get('enforcement'))
print("RS_BYPASS=%d" % len(d.get('bypass_actors') or []))
print("RS_PR=%s" % ('yes' if 'pull_request' in types else 'no'))
print("RS_FF=%s" % ('yes' if 'non_fast_forward' in types else 'no'))
print("RS_DEL=%s" % ('yes' if 'deletion' in types else 'no'))
pr=next((r for r in d.get('rules',[]) if r['type']=='pull_request'), None)
p=(pr or {}).get('parameters') or {}
print("RS_APPROVALS=%s" % p.get('required_approving_review_count','?'))
print("RS_CODEOWNER=%s" % str(p.get('require_code_owner_review')).lower())
RSPY
    printf '%s' "$RSD" | python3 "$VTMP/rs.py" > "$VTMP/rs.env" 2>/dev/null || true
    RS_ENF=""; RS_BYPASS=""; RS_PR=""; RS_FF=""; RS_DEL=""
    # shellcheck disable=SC1090
    . "$VTMP/rs.env"
    [ "$RS_ENF" = "active" ] && row PASS "branch ruleset is ACTIVE (not evaluate/disabled)" "enforcement=$RS_ENF" \
                             || row FAIL "branch ruleset is ACTIVE" "enforcement=$RS_ENF"
    [ "$RS_PR"  = "yes" ] && row PASS "pull request required before merge" "rule: pull_request" \
                          || row FAIL "pull request required before merge" "rule missing"
    [ "$RS_FF"  = "yes" ] && row PASS "force pushes blocked" "rule: non_fast_forward" \
                          || row FAIL "force pushes blocked" "rule missing"
    [ "$RS_DEL" = "yes" ] && row PASS "branch deletion blocked" "rule: deletion" \
                          || row FAIL "branch deletion blocked" "rule missing"
    # Reported as its own row rather than left implicit: a `pull_request` rule with zero required
    # approvals still blocks every direct push, but it does NOT mean anyone reviewed anything.
    # Saying so out loud is the difference between a control and a decoration.
    row PASS "  -> approvals required before merge" "${RS_APPROVALS:-?} (solo maintainer; code-owner review=${RS_CODEOWNER:-?}. Self-approval is refused by GitHub, so a non-zero value here would make main unmergeable - ops/SETUP-BY-HAND.md step 11)"
    if [ "$RS_BYPASS" = "0" ]; then
      row PASS "ADMIN BYPASS OFF (bypass_actors empty)" "0 actors - applies to the owner too"
    else
      row FAIL "ADMIN BYPASS OFF" "$RS_BYPASS bypass actor(s) - this is the ChainDrop hole"
    fi
  elif [ $LEGACY_RC -eq 0 ]; then
    eval "$(printf '%s' "$LEGACY_RAW" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f\"L_ADMIN={str(d.get('enforce_admins',{}).get('enabled')).lower()}\")
print(f\"L_PR={'yes' if d.get('required_pull_request_reviews') else 'no'}\")
print(f\"L_FF={str(d.get('allow_force_pushes',{}).get('enabled')).lower()}\")
print(f\"L_DEL={str(d.get('allow_deletions',{}).get('enabled')).lower()}\")
")"
    [ "$L_PR" = "yes" ]     && row PASS "pull request required before merge (legacy API)" "ok" || row FAIL "pull request required before merge" "not set"
    [ "$L_FF" = "false" ]   && row PASS "force pushes blocked (legacy API)" "ok"                || row FAIL "force pushes blocked" "allowed"
    [ "$L_DEL" = "false" ]  && row PASS "branch deletion blocked (legacy API)" "ok"             || row FAIL "branch deletion blocked" "allowed"
    [ "$L_ADMIN" = "true" ] && row PASS "ADMIN BYPASS OFF (enforce_admins)" "ok"                || row FAIL "ADMIN BYPASS OFF" "admins can bypass - this is the ChainDrop hole"
  else
    DETAIL="no ruleset and no legacy protection"
    if grep -q "Upgrade to GitHub Pro" <<<"$RS_RAW$LEGACY_RAW"; then
      DETAIL="BLOCKED BY PLAN: GitHub Free does not allow branch protection on PRIVATE repos"
    fi
    row FAIL "branch protection on ${DEFBR:-main}" "$DETAIL"
    row FAIL "  -> pull request required before merge" "not enforced"
    row FAIL "  -> force pushes blocked" "not enforced"
    row FAIL "  -> branch deletion blocked" "not enforced"
    row FAIL "  -> ADMIN BYPASS OFF" "not enforced"
  fi
else
  row UNVERIFIED "branch protection" "GitHub unreachable"
fi

# ---------------------------------------------------------------------------
# 3. `release` deployment environment with a required reviewer
# ---------------------------------------------------------------------------
if [ $GH_OK -eq 1 ]; then
  ENV_RAW="$(gh api "repos/$REPO_SLUG/environments/release" 2>&1)"
  if [ $? -ne 0 ]; then
    row FAIL "\`release\` environment exists" "not found - the workflow's environment gate is inert"
    row FAIL "  -> required reviewer configured" "no environment"
  else
    row PASS "\`release\` environment exists" "the workflow references it"
    cat > "$VTMP/env.py" <<'ENVPY'
import json,sys
d=json.load(sys.stdin)
rules=d.get('protection_rules') or []
rev=[r for r in rules if r.get('type')=='required_reviewers']
n=sum(len(r.get('reviewers') or []) for r in rev)
print("ENV_REV=%d" % n)
print("ENV_SELF=%s" % str(any(r.get('prevent_self_review') for r in rev)).lower())
ENVPY
    printf '%s' "$ENV_RAW" | python3 "$VTMP/env.py" > "$VTMP/env.env" 2>/dev/null || true
    ENV_REV=0; ENV_SELF=false
    # shellcheck disable=SC1090
    . "$VTMP/env.env"
    if [ "${ENV_REV:-0}" -gt 0 ]; then
      row PASS "required reviewer on \`release\`" "$ENV_REV reviewer(s)"
      [ "$ENV_SELF" = "true" ] && row PASS "  -> self-review prevented" "prevent_self_review=true" \
                               || row PASS "  -> self-review allowed (solo maintainer)" "see ops/SETUP-RESEARCH.md section 3"
    else
      row FAIL "required reviewer on \`release\`" "0 reviewers - approval gate NOT active"
    fi
  fi
else
  row UNVERIFIED "\`release\` environment" "GitHub unreachable"
fi

# ---------------------------------------------------------------------------
# 4. No write-scoped tokens lying around
#    Classic PATs cannot be listed via the REST API with a PAT/OAuth token, so this
#    is reported honestly as UNVERIFIED rather than guessed at.
# ---------------------------------------------------------------------------
if [ $GH_OK -eq 1 ]; then
  SCOPES="$(gh auth status 2>&1 | grep -o "Token scopes:.*" | head -1)"
  row PASS "gh CLI token scopes visible" "${SCOPES:-unknown}"
  if grep -qE "'(repo|workflow|write:packages|admin:org|delete_repo)'" <<<"$SCOPES"; then
    row FAIL "gh CLI token is not over-scoped" "write scopes present. Required for THIS setup; rotate to read-only or revoke once hardening is done - ops/SETUP-BY-HAND.md step 2"
  else
    row PASS "gh CLI token is not over-scoped" "$SCOPES"
  fi
  row UNVERIFIED "no classic PATs remain on the account" "GitHub exposes no API to list a user's own PATs - MANUAL: github.com/settings/tokens"
else
  row UNVERIFIED "token audit" "GitHub unreachable"
fi

# ---------------------------------------------------------------------------
# 5. Release workflow: OIDC, minimum permissions, SHA-pinned actions, env gate
# ---------------------------------------------------------------------------
WF=".github/workflows/release.yml"
if [ ! -f "$WF" ]; then
  row FAIL "release workflow present" "$WF missing"
else
  row PASS "release workflow present" "$WF"
  grep -q "id-token: write" "$WF"  && row PASS "workflow requests id-token: write (OIDC)" "ok" || row FAIL "workflow requests id-token: write" "missing - trusted publishing cannot work"
  grep -q "contents: read"  "$WF"  && row PASS "workflow permissions are minimal" "contents: read" || row FAIL "workflow permissions are minimal" "contents: read not found"
  grep -q "environment: release" "$WF" && row PASS "workflow gated on the \`release\` environment" "ok" || row FAIL "workflow gated on \`release\`" "missing"
  grep -q -- "--provenance" "$WF" && row PASS "provenance enabled on publish" "ok" || row FAIL "provenance enabled on publish" "missing"

  # Strip comment lines first: the workflow's own header says "There is NO NPM_TOKEN ...",
  # and a check that trips on its own documentation is a check nobody will trust.
  if sed 's/#.*$//' "$WF" | grep -qE "NPM_TOKEN|NODE_AUTH_TOKEN|npm_[A-Za-z0-9]{20,}"; then
    row FAIL "no NPM_TOKEN anywhere in the workflow" "a token reference was found in executable YAML"
  else
    row PASS "no NPM_TOKEN anywhere in the workflow" "trusted publishing only (comments excluded)"
  fi

  # STAGED PUBLISHING. The workflow must be able to STAGE and must not be able to release.
  #
  # Two independent controls; this checks the half that lives in this repository. The other half
  # is the trusted publisher on npmjs.com being configured with --allow-stage-publish and NOT
  # --allow-publish, which no script here can read - see ops/PUBLISH-TODAY.md step 6.
  #
  # Comments are stripped first, exactly as for the token check below: the workflow's header
  # explains at length what it does NOT do, and a check that trips on its own documentation is a
  # check nobody will trust.
  WFCODE="$(sed 's/#.*$//' "$WF")"
  if printf '%s' "$WFCODE" | grep -qE "npm[[:space:]]+stage[[:space:]]+publish"; then
    row PASS "release is STAGED, not published" "the workflow uploads to the staging queue"
  else
    row FAIL "release is STAGED, not published" "no staging step found - a direct release cannot be gated on npm 2FA"
  fi
  if printf '%s' "$WFCODE" | grep -qE "npm[[:space:]]+publish([[:space:]]|$)"; then
    row FAIL "the workflow cannot release on its own" "an executable direct-release command is present"
  else
    row PASS "the workflow cannot release on its own" "staging only; a human approves with a security key"
  fi

  # Node floor. `engines.node` is >=22.13.0 for CONSUMERS; npm documents >=22.14.0 for trusted
  # AND staged publishing, and this job depends on both. A pin one patch under the floor of the
  # feature the workflow is built on is the kind of thing that only fails on release day.
  NODEPIN="$(grep -oE "node-version: *'[0-9]+\.[0-9]+\.[0-9]+'" "$WF" | grep -oE "[0-9]+\.[0-9]+\.[0-9]+" | head -1)"
  if [ -z "$NODEPIN" ]; then
    row UNVERIFIED "CI Node meets the publishing floor" "no exact node-version pin found in $WF"
  elif [ "$(printf '22.14.0\n%s\n' "$NODEPIN" | sort -V | head -1)" = "22.14.0" ]; then
    row PASS "CI Node meets the publishing floor" "$NODEPIN >= 22.14.0"
  else
    row FAIL "CI Node meets the publishing floor" "$NODEPIN is below npm's documented 22.14.0"
  fi

  UNPINNED="$(grep -oE "uses: +[A-Za-z0-9._/-]+@[A-Za-z0-9._-]+" "$WF" | grep -vE "@[0-9a-f]{40}$" || true)"
  if [ -n "$UNPINNED" ]; then
    row FAIL "every action pinned to a commit SHA" "$(printf '%s' "$UNPINNED" | tr '\n' ' ')"
  else
    NPINS="$(grep -cE "uses: +[A-Za-z0-9._/-]+@[0-9a-f]{40}" "$WF")"
    row PASS "every action pinned to a commit SHA" "$NPINS action(s), no tags"
  fi
fi

# ---------------------------------------------------------------------------
# 5b. What is ALREADY published, not just what is about to be
# ---------------------------------------------------------------------------
#
# Every publication scan this project runs is pointed at what we are ABOUT to ship. None was ever
# pointed at what we ALREADY shipped, and the two are different questions: a file that went public
# before a scan rule existed is invisible to every scan written since.
#
# That gap was not theoretical. `ops/BOT-SCOPE.md` carried an operator-identity string on the
# public repository while the private tree had already been corrected, and no scan on either side
# could see it - the private one because the file was fixed, the public one because nobody looked
# (D-140).
#
# This fetches the public repository's CURRENT files and runs the same identity strings over them.
# Read-only: it fetches, it never pushes.
PUBLIC_REMOTE_URL="$(git remote get-url public 2>/dev/null || true)"
if [ -z "$PUBLIC_REMOTE_URL" ]; then
  row UNVERIFIED "the PUBLISHED tree carries no identity string" "no 'public' remote configured here"
elif [ ! -x scripts/pre-public-scan.sh ]; then
  row UNVERIFIED "the PUBLISHED tree carries no identity string" "scripts/pre-public-scan.sh is missing"
elif ! git fetch -q public 2>/dev/null; then
  row UNVERIFIED "the PUBLISHED tree carries no identity string" "could not fetch the public remote"
else
  # REUSE THE REAL SCANNER. Do not reimplement it.
  #
  # The first version of this check read scripts/scan-identity.txt directly and reported PASS on a
  # repository where the exposed string was sitting in a file I had already read with my own eyes.
  # The reason: that file holds the EXTRA strings, and the scanner DERIVES the machine hostname and
  # account name on top of them - which is where the exposed string came from. A second copy of a
  # rule drifts from the first (D-124), and here the drift was invisible because the wrong answer
  # was the green one.
  #
  # pre-public-scan.sh takes any ref, so the already-published tree is just another ref.
  #
  # TWO ROWS, NOT ONE. This started as a single row and the single row was wrong, in a way that
  # would have taught somebody to ignore it (D-142).
  #
  #   the published TREE     what a person who visits the repository reads TODAY.
  #                          FIXABLE, by a PR. Must be green, and is.
  #   the published HISTORY  every blob any commit ever carried. NOT fixable by a PR - only by a
  #                          history rewrite, and on a public repository GitHub keeps unreachable
  #                          objects fetchable by SHA for a long time afterwards anyway.
  #
  # Folding them together produced a row that could never go green no matter what anyone did,
  # because the founder pushing the correct fix does not and cannot change the history behind it.
  # A control that stays red after the correct action was taken is a control people stop reading,
  # and the next real finding arrives in a row everyone has learned to skip.

  # --- row 1: the tree, fetched live from GitHub -------------------------------------------
  # Delegates to scripts/scan-published-head.sh, which asks GitHub what HEAD is right now over
  # two independent routes, asserts the object it scans is the SHA GitHub named, and self-tests
  # by planting identity strings in a copy of that tree and requiring the scan to block on them.
  PUBHEAD="$(mktemp)"
  ./scripts/scan-published-head.sh --self-test > "$PUBHEAD" 2>&1; PH_RC=$?
  PUB_SHA="$(awk '/^HEAD \(git ls-remote\):/{print substr($NF,1,10)}' "$PUBHEAD")"
  case $PH_RC in
    0) row PASS "the PUBLISHED TREE carries no identity string" \
         "live HEAD ${PUB_SHA:-?} fetched from GitHub, scan self-tested, 0 findings" ;;
    3) row UNVERIFIED "the PUBLISHED TREE carries no identity string" \
         "could not reach GitHub - the published tree was NOT examined" ;;
    *) row FAIL "the PUBLISHED TREE carries no identity string" \
         "$(grep -cE '^BLOCKER|^  FAIL' "$PUBHEAD" | tr -d ' ') finding(s) on live HEAD ${PUB_SHA:-?} - run: ./scripts/scan-published-head.sh" ;;
  esac
  rm -f "$PUBHEAD"

  # --- row 2: the history behind it ---------------------------------------------------------
  # Expected to FAIL, and the FAIL is a true statement about the posture rather than a defect -
  # the same reasoning that keeps the gh-token scope row red. It is a founder decision (accept,
  # or rewrite history and force-push, which is exception 1), not an engineering task, so it is
  # reported plainly and left visible rather than explained away.
  PUBSCAN="$(mktemp)"
  if SCAN_REF=public/main SCAN_CLASSES=identity ./scripts/pre-public-scan.sh > "$PUBSCAN" 2>&1; then
    row PASS "the PUBLISHED HISTORY carries no identity string" "SCAN_REF=public/main history is clean"
  else
    # The scan redacts matching lines itself, so this summary cannot leak the string.
    # Report the COUNTS, not just "it failed". This row is expected to stay red - the findings
    # are immutable without a history rewrite - so the only way it can still carry information is
    # if a CHANGE in it is visible. A row that says the same thing forever is one nobody reads;
    # a row that says "2 blobs, 1 commit, unchanged since 2026-08-21" is one where a 3 is loud.
    PUB_BLOBS="$(awk '/^BLOCKER  pattern scan:/{print $4}' "$PUBSCAN")"
    PUB_META="$(awk '/^BLOCKER  commit metadata:/{print $4}' "$PUBSCAN")"
    row FAIL "the PUBLISHED HISTORY carries no identity string" \
      "${PUB_BLOBS:-0} blob(s) + ${PUB_META:-0} commit header(s); baseline is 1 + 1 - NOT fixable by a PR, D-142/D-145"
  fi
  rm -f "$PUBSCAN"
fi

# ---------------------------------------------------------------------------
# 6. Repo hygiene files
# ---------------------------------------------------------------------------
for f in .github/dependabot.yml .github/CODEOWNERS SECURITY.md LICENSE .npmrc; do
  [ -s "$f" ] && row PASS "$f present" "$(wc -l < "$f" | tr -d ' ') lines" || row FAIL "$f present" "missing or empty"
done
grep -q "cooldown" .github/dependabot.yml 2>/dev/null \
  && row PASS "dependabot honours a cooldown" "matches .npmrc min-release-age" \
  || row FAIL "dependabot honours a cooldown" "no cooldown - updates could land the day they publish"

# ---------------------------------------------------------------------------
# 7. package.json: no install scripts
# ---------------------------------------------------------------------------
BAD="$(python3 -c "
import json
p=json.load(open('package.json'))
print(','.join(k for k in ('preinstall','install','postinstall','prepare','prepublish') if k in (p.get('scripts') or {})))
" 2>/dev/null)"
if [ -z "$BAD" ]; then
  row PASS "package.json has NO install scripts" "the ChainDrop mechanism is absent"
else
  row FAIL "package.json has NO install scripts" "found: $BAD"
fi
LOCKBAD="$(python3 -c "
import json
try: lock=json.load(open('package-lock.json'))
except Exception: print('UNREADABLE'); raise SystemExit
bad=[n or '<root>' for n,e in (lock.get('packages') or {}).items()
     if e.get('hasInstallScript') or any((e.get('scripts') or {}).get(k) for k in ('preinstall','install','postinstall','prepare'))]
print(','.join(bad))
" 2>/dev/null)"
case "$LOCKBAD" in
  "")           row PASS "lockfile has NO install scripts" "every entry clean" ;;
  UNREADABLE)   row UNVERIFIED "lockfile has NO install scripts" "package-lock.json missing or unreadable" ;;
  *)            row FAIL "lockfile has NO install scripts" "found: $LOCKBAD" ;;
esac

# ---------------------------------------------------------------------------
# 8. npm client and registry-side settings
# ---------------------------------------------------------------------------
if ! command -v npm >/dev/null 2>&1; then
  row UNVERIFIED "npm CLI available" "npm not installed"
else
  NPMV="$(npm --version)"
  if python3 -c "
import sys
def t(v): return tuple(int(x) for x in v.split('.')[:3])
sys.exit(0 if t('$NPMV') >= (11,10,0) else 1)"; then
    row PASS "npm CLI >= 11.10.0 (min-release-age support)" "$NPMV"
  else
    row FAIL "npm CLI >= 11.10.0" "$NPMV - min-release-age is NOT supported on this version"
  fi

  MRA="$(npm config get min-release-age 2>/dev/null)"
  case "$MRA" in
    ""|undefined|null) row FAIL "local npm min-release-age set" "unset - a version published minutes ago would install" ;;
    *) if [ "$MRA" -ge 1 ] 2>/dev/null; then row PASS "local npm min-release-age set" "$MRA days"; else row FAIL "local npm min-release-age set" "$MRA"; fi ;;
  esac
  grep -q "^min-release-age=" .npmrc 2>/dev/null \
    && row PASS "committed .npmrc pins min-release-age" "$(grep '^min-release-age=' .npmrc)" \
    || row FAIL "committed .npmrc pins min-release-age" "not in .npmrc - contributors get no cooldown"

  # Registry-side settings. If the package is unpublished these CANNOT be checked, and saying
  # "pass" here would be the exact lie this script exists to avoid.
  # Does a package by this name exist, and if so is it OURS? A name that resolves to somebody
  # else's package is a much more urgent finding than an unconfigured setting.
  NPM_WHO="$(npm whoami 2>/dev/null || true)"
  if npm view "$PKG" version >/dev/null 2>&1; then
    MAINT="$(npm view "$PKG" maintainers --json 2>/dev/null | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print(''); raise SystemExit
print(','.join(m.get('name','?') if isinstance(m,dict) else str(m) for m in (d if isinstance(d,list) else [d])))
" 2>/dev/null)"
    if [ -n "$NPM_WHO" ] && printf '%s' "$MAINT" | grep -q "$NPM_WHO"; then
      row UNVERIFIED "npm 'require 2FA and disallow tokens'" "no public API for publishing-access - MANUAL: npmjs.com/package/$PKG/access"

      # THE TRUSTED PUBLISHER IS READABLE AFTER ALL - not as a SETTING, but as a FACT ABOUT WHAT
      # WAS PUBLISHED, which is the better thing to check anyway.
      #
      # This row was UNVERIFIED for the whole life of the project on the correct grounds that npm
      # exposes no read API for the trusted-publisher CONFIGURATION: GET on the access endpoint is
      # 405, every other candidate path is 404, `npm access` has no getter, and npm's own docs
      # describe the setting as web-UI-only (D-238). All still true.
      #
      # But the packument records HOW EACH VERSION GOT THERE, unauthenticated and public:
      #
      #   _npmUser.trustedPublisher.id   "github"  - published via a trusted publisher, over OIDC
      #   _npmUser.name                  "GitHub Actions"      - not a human with a token
      #   _npmUser.approver.name         the human who approved the staged artifact
      #
      # A setting says what is meant to happen; this says what DID happen, on the artifact users
      # actually install. It cannot be satisfied by a publisher that is configured but unused, and
      # it cannot be faked by a token publish. That is a stronger control than reading the page,
      # and it is exactly what CLAUDE.md §4.3 means by "only production proves it fires".
      #
      # What it still does NOT prove, and is not claimed: that the permission is `stage publish`
      # ONLY rather than also `publish`. Proving that needs either the settings page or an
      # attempted direct publish, and the second is §7 exception 1 and is never to be attempted.
      TP="$(npm view "$PKG@latest" _npmUser --json 2>/dev/null | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: raise SystemExit
if not isinstance(d,dict): raise SystemExit
tp=(d.get('trustedPublisher') or {}).get('id','')
ap=(d.get('approver') or {}).get('name','')
print('%s|%s|%s' % (tp, d.get('name',''), ap))
" 2>/dev/null)"
      TP_ID="${TP%%|*}"; TP_REST="${TP#*|}"; TP_WHO="${TP_REST%%|*}"; TP_APPROVER="${TP_REST#*|}"
      if [ -n "$TP_ID" ]; then
        row PASS "npm trusted publisher configured" \
          "registry says $PKG@latest was published by '${TP_WHO}' via trusted publisher '${TP_ID}'${TP_APPROVER:+, approved by ${TP_APPROVER}}"
      else
        row UNVERIFIED "npm trusted publisher configured" "latest of '$PKG' carries no trustedPublisher - it may predate the publisher, or have been published with a token - MANUAL: npmjs.com/package/$PKG/access"
      fi
    else
      row FAIL "npm package name '$PKG' is available or ours" "TAKEN by: ${MAINT:-unknown}. Pick another name - see launch/NAME-CANDIDATES.md"
      row UNVERIFIED "npm 'require 2FA and disallow tokens'" "cannot configure a package you do not own"
      row UNVERIFIED "npm trusted publisher configured" "cannot configure a package you do not own"
    fi
  else
    row PASS "npm package name '$PKG' is unclaimed" "no package by that name on the registry"
    row UNVERIFIED "npm 'require 2FA and disallow tokens'" "package '$PKG' is not published yet - cannot be configured or checked"
    row UNVERIFIED "npm trusted publisher configured" "package '$PKG' is not published yet - chicken-and-egg, see ops/SETUP-BY-HAND.md"
  fi
  row UNVERIFIED "npm account 2FA enabled" "npm exposes no API for another party to read your 2FA state - MANUAL: npmjs.com/settings/~/profile"
fi

# ---------------------------------------------------------------------------
# THE PRE-PUSH GUARD, ON THIS MACHINE
# ---------------------------------------------------------------------------
# The unit tests prove the hook REFUSES the public URL - they invoke it and check the exit code.
# What they cannot prove is that git will ever invoke it, because that is `core.hooksPath` on one
# machine, and a CI runner has never run the installer. Asserting it in the unit suite asserted a
# falsehood on every CI leg; asserting it here asserts it exactly where it can be true, on the
# machine that actually pushes.
HOOKS_PATH="$(git config core.hooksPath 2>/dev/null || true)"
if [ ! -x "$ROOT/.githooks/pre-push" ]; then
  row FAIL "pre-push guard installed on this machine" ".githooks/pre-push is missing or not executable"
elif [ "$HOOKS_PATH" = ".githooks" ]; then
  # Present and pointed at is still not proof that it FIRES. Invoke it with the public URL and
  # require a refusal - the same A/B the tests run, repeated against the real file on disk.
  if printf '' | "$ROOT/.githooks/pre-push" public "https://github.com/djayamah/usewarden.git" >/dev/null 2>&1; then
    row FAIL "pre-push guard refuses the public repository" "the hook ACCEPTED a push to the public repo URL"
  else
    row PASS "pre-push guard installed and refusing" "core.hooksPath=.githooks, public URL refused"
  fi
elif [ -z "$HOOKS_PATH" ]; then
  row FAIL "pre-push guard installed on this machine" "core.hooksPath is unset - run scripts/install-git-hooks.sh"
else
  row FAIL "pre-push guard installed on this machine" "core.hooksPath points somewhere else, not .githooks"
fi

# ---------------------------------------------------------------------------
echo
printf 'PASS %d    FAIL %d    UNVERIFIED %d\n' "$PASS" "$FAIL" "$UNVERIFIED"
echo
echo "UNVERIFIED means this script could not check the control. It is counted as a FAILURE."
echo "A control whose state is unknown is not a control. Each UNVERIFIED row names the manual"
echo "step that settles it - see ops/SETUP-BY-HAND.md."
echo
if [ $FAIL -eq 0 ] && [ $UNVERIFIED -eq 0 ]; then
  echo "=== ALL CONTROLS VERIFIED ==="
  exit 0
fi
echo "=== NOT FULLY HARDENED: $FAIL failed, $UNVERIFIED could not be verified ==="
exit 1
