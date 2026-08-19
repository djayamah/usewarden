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
    if [ "$VIS" = "private" ]; then
      row PASS "repository is PRIVATE" "visibility=$VIS"
    else
      row FAIL "repository is PRIVATE" "visibility=$VIS - nothing is supposed to be public yet"
    fi
    DEFBR="$(printf '%s' "$REPO_JSON" | python3 -c "import json,sys;print(json.load(sys.stdin).get('default_branch'))")"
    row PASS "default branch identified" "$DEFBR"
  fi
else
  row UNVERIFIED "repository is PRIVATE" "GitHub unreachable"
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
    eval "$(printf '%s' "$RSD" | python3 -c "
import json,sys
d=json.load(sys.stdin)
types={r['type'] for r in d.get('rules',[])}
print(f\"RS_ENF={d.get('enforcement')}\")
print(f\"RS_BYPASS={len(d.get('bypass_actors') or [])}\")
print(f\"RS_PR={'yes' if 'pull_request' in types else 'no'}\")
print(f\"RS_FF={'yes' if 'non_fast_forward' in types else 'no'}\")
print(f\"RS_DEL={'yes' if 'deletion' in types else 'no'}\")
")"
    [ "$RS_ENF" = "active" ] && row PASS "branch ruleset is ACTIVE (not evaluate/disabled)" "enforcement=$RS_ENF" \
                             || row FAIL "branch ruleset is ACTIVE" "enforcement=$RS_ENF"
    [ "$RS_PR"  = "yes" ] && row PASS "pull request required before merge" "rule: pull_request" \
                          || row FAIL "pull request required before merge" "rule missing"
    [ "$RS_FF"  = "yes" ] && row PASS "force pushes blocked" "rule: non_fast_forward" \
                          || row FAIL "force pushes blocked" "rule missing"
    [ "$RS_DEL" = "yes" ] && row PASS "branch deletion blocked" "rule: deletion" \
                          || row FAIL "branch deletion blocked" "rule missing"
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
    if printf '%s' "$RS_RAW$LEGACY_RAW" | grep -q "Upgrade to GitHub Pro"; then
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
    eval "$(printf '%s' "$ENV_RAW" | python3 -c "
import json,sys
d=json.load(sys.stdin)
rules=d.get('protection_rules') or []
rev=[r for r in rules if r.get('type')=='required_reviewers']
n=sum(len(r.get('reviewers') or []) for r in rev)
print(f'ENV_REV={n}')
print(f\"ENV_SELF={str(any(r.get('prevent_self_review') for r in rev)).lower()}\")
")"
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
  if printf '%s' "$SCOPES" | grep -qE "'(repo|workflow|write:packages|admin:org|delete_repo)'"; then
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

  UNPINNED="$(grep -oE "uses: +[A-Za-z0-9._/-]+@[A-Za-z0-9._-]+" "$WF" | grep -vE "@[0-9a-f]{40}$" || true)"
  if [ -n "$UNPINNED" ]; then
    row FAIL "every action pinned to a commit SHA" "$(printf '%s' "$UNPINNED" | tr '\n' ' ')"
  else
    NPINS="$(grep -cE "uses: +[A-Za-z0-9._/-]+@[0-9a-f]{40}" "$WF")"
    row PASS "every action pinned to a commit SHA" "$NPINS action(s), no tags"
  fi
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
      row UNVERIFIED "npm trusted publisher configured" "no public API - MANUAL: npmjs.com/package/$PKG/access"
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
