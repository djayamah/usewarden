#!/usr/bin/env bash
# APPLY HARDENING (idempotent).
#
# Applies every GitHub-side control that CAN be applied via API. Run it again after resolving
# step 3 of ops/SETUP-BY-HAND.md (GitHub Pro, or making the repo public) - the two controls that
# GitHub Free refuses on a private repository will then succeed.
#
# It never pretends. A control the plan refuses is reported as BLOCKED with the API's own
# message, not silently skipped.
set -uo pipefail

REPO_SLUG="${REPO:-djayamah/usewarden}"
OWNER="${REPO_SLUG%%/*}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

echo "=== APPLY HARDENING: $REPO_SLUG ==="
echo

say() { printf '%-9s %s\n' "$1" "$2"; }

# --- repository settings ---------------------------------------------------
echo "--- repository settings ---"
if OUT="$(gh api -X PATCH "repos/$REPO_SLUG" \
    -F has_wiki=false -F delete_branch_on_merge=true -F web_commit_signoff_required=true \
    -F allow_auto_merge=false 2>&1)"; then
  say OK "wiki off, branch auto-delete on, web commit signoff required, auto-merge off"
else
  say FAILED "repository settings: $(printf '%s' "$OUT" | head -1)"
fi

for ep in vulnerability-alerts automated-security-fixes; do
  if gh api -X PUT "repos/$REPO_SLUG/$ep" >/dev/null 2>&1; then say OK "$ep enabled"
  else say FAILED "$ep could not be enabled"; fi
done

# --- branch ruleset --------------------------------------------------------
echo
echo "--- branch protection on the default branch ---"
DEFBR="$(gh api "repos/$REPO_SLUG" --jq .default_branch 2>/dev/null || echo main)"
cat > "$TMP/ruleset.json" <<JSON
{
  "name": "protect-main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [],
  "rules": [
    { "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["squash", "merge", "rebase"]
      } },
    { "type": "non_fast_forward" },
    { "type": "deletion" }
  ]
}
JSON
# require_code_owner_review and require_last_push_approval are FALSE while there is one
# maintainer, and the reason is the same one as D-040: with a single code owner who is also the
# only author, GitHub refuses "Can not approve your own pull request", so the gate becomes a lock
# with no key. Measured, not assumed - the first pull request opened against this ruleset was
# BLOCKED, and the self-approval attempt returned 422. The escape from that is either an admin
# bypass merge, which is the exact hole this ruleset exists to close, or an honest setting.
#
# What still holds with them false: `pull_request` means main CANNOT be pushed to directly, by
# anyone including the owner; `non_fast_forward` blocks force pushes; `deletion` blocks deletion;
# `bypass_actors` is empty so none of it is skippable. What is given up: nothing today, because a
# solo maintainer's code-owner approval was never obtainable. ops/SETUP-BY-HAND.md step 11 says
# to set BOTH back to true, together with the environment's prevent_self_review, on the day a
# second maintainer exists.
#
# bypass_actors is EMPTY on purpose. That is the control that breaks the ChainDrop chain, in
# which the operators pushed straight to main. It must apply to the repository owner too.
# A failed `gh api --jq` still prints the error body to stdout, so the exit status has to be
# checked before the value is used - otherwise a 403 body ends up interpolated into the next URL.
if RS_LIST="$(gh api "repos/$REPO_SLUG/rulesets" 2>/dev/null)"; then
  EXISTING="$(printf '%s' "$RS_LIST" | python3 -c "
import json,sys
try: rs=json.load(sys.stdin)
except Exception: rs=[]
print(next((str(r['id']) for r in rs if isinstance(r,dict) and r.get('name')=='protect-main'), ''))
" 2>/dev/null)"
else
  EXISTING=""
fi
if [ -n "$EXISTING" ]; then
  if OUT="$(gh api -X PUT "repos/$REPO_SLUG/rulesets/$EXISTING" --input "$TMP/ruleset.json" 2>&1)"; then
    say OK "ruleset 'protect-main' updated (id=$EXISTING), bypass_actors=0"
  else
    say FAILED "ruleset update: $(printf '%s' "$OUT" | head -1)"
  fi
else
  if OUT="$(gh api -X POST "repos/$REPO_SLUG/rulesets" --input "$TMP/ruleset.json" 2>&1)"; then
    say OK "ruleset 'protect-main' created, bypass_actors=0 (applies to the owner too)"
  elif grep -q "Upgrade to GitHub Pro" <<<"$OUT"; then
    say BLOCKED "branch protection: GitHub Free does not allow it on PRIVATE repos."
    echo "          Resolve step 3 of ops/SETUP-BY-HAND.md, then re-run this script."
  else
    say FAILED "ruleset create: $(printf '%s' "$OUT" | head -1)"
  fi
fi

# --- release environment ---------------------------------------------------
echo
echo "--- release environment ---"
UID_NUM="$(gh api "users/$OWNER" --jq .id 2>/dev/null)"
cat > "$TMP/env-full.json" <<JSON
{
  "wait_timer": 0,
  "prevent_self_review": false,
  "reviewers": [ { "type": "User", "id": ${UID_NUM:-0} } ],
  "deployment_branch_policy": { "protected_branches": true, "custom_branch_policies": false }
}
JSON
# prevent_self_review is false BY DESIGN while there is one maintainer: with it true and a single
# reviewer, nobody could ever approve a release and the gate would be a lock with no key. Flip it
# to true the day a second maintainer exists (ops/SETUP-BY-HAND.md step 11).
if OUT="$(gh api -X PUT "repos/$REPO_SLUG/environments/release" --input "$TMP/env-full.json" 2>&1)"; then
  say OK "environment 'release' with required reviewer @$OWNER, protected branches only"
elif grep -qi "billing plan" <<<"$OUT"; then
  say BLOCKED "required reviewers: not available on this plan for a PRIVATE repo."
  # Even `wait_timer: 0` is rejected on this plan - it counts as creating a protection rule.
  # An empty body creates the environment with no rules at all, which is what Free allows.
  printf '%s' '{}' > "$TMP/env-min.json"
  if gh api -X PUT "repos/$REPO_SLUG/environments/release" --input "$TMP/env-min.json" >/dev/null 2>&1; then
    say OK "environment 'release' created WITHOUT a reviewer gate"
    echo "          The workflow's \`environment: release\` still scopes the OIDC token, which"
    echo "          npm's trusted-publisher config binds to - so it is not worthless. But the"
    echo "          HUMAN APPROVAL GATE IS NOT ACTIVE. See ops/SETUP-BY-HAND.md step 11."
  else
    say FAILED "could not create the environment at all"
  fi
else
  say FAILED "environment: $(printf '%s' "$OUT" | head -1)"
fi

echo
echo "Now run: ./scripts/verify-hardening.sh"
