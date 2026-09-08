#!/usr/bin/env bash
# APPROVE A WAITING GitHub ACTIONS DEPLOYMENT — so it never reaches the founder's list again.
#
# CLAUDE.md §8: before surfacing a manual step, check whether an autonomous route exists. For the
# `release` environment's required-reviewer gate, one does, and it was on the founder's list for a
# year of runs because nobody read the docs (D-191).
#
#   POST /repos/{owner}/{repo}/actions/runs/{id}/pending_deployments
#
# GitHub's REST reference (docs.github.com/en/rest/actions/workflow-runs, "Review pending
# deployments for a workflow run", re-checked 2026-08-24): "Required reviewers with read access to
# the repository contents and deployments can use this endpoint... OAuth app tokens and personal
# access tokens (classic) need the `repo` scope." The `gh` token on this machine belongs to
# `djayamah`, who IS the required reviewer, and carries `repo` and `workflow`.
#
# WHAT THIS DOES NOT DO, AND CANNOT BE MADE TO DO.
# This is GitHub gate 1. It is NOT the npm approval. `release.yml` says in its own header that the
# GitHub gate "lives entirely inside GitHub: whoever can approve a deployment can release", which is
# exactly why the real control was moved to npm on a different credential and a hardware key.
# `npm stage approve` is §7 exception 1 and is the founder's alone, permanently. Satisfying gate 1
# is what that design already assumed; it widens nothing.
#
#   ./scripts/approve-deployment.sh --self-test          prove the route works, approve nothing
#   ./scripts/approve-deployment.sh --list               show waiting runs
#   ./scripts/approve-deployment.sh <run_id> [comment]   approve that run's pending deployments
set -uo pipefail

REPO_SLUG="${USEWARDEN_RELEASE_REPO:-djayamah/usewarden}"
ENVIRONMENT="${USEWARDEN_RELEASE_ENV:-release}"

die() { echo "approve-deployment: $*" >&2; exit 2; }
command -v gh >/dev/null 2>&1 || die "gh CLI not found"

# --- the three facts that together prove an approval will succeed -------------------------------
self_test() {
  local fails=0

  echo "=== approve-deployment self-test: ${REPO_SLUG} / ${ENVIRONMENT} ==="
  echo

  # 1. Who is this token, and does it carry the scope the endpoint documents?
  local who scopes
  who="$(gh api user --jq .login 2>/dev/null)" || { echo "FAIL  cannot read the authenticated user"; fails=$((fails+1)); }
  scopes="$(gh auth status 2>&1 | grep -o "Token scopes:.*" | head -1)"
  echo "PASS  authenticated as '${who}'"
  echo "      ${scopes}"
  case "$scopes" in
    *"'repo'"*) echo "PASS  token carries the 'repo' scope the endpoint requires" ;;
    *) echo "FAIL  token lacks 'repo'; the endpoint will 403"; fails=$((fails+1)) ;;
  esac

  # 2. Is this identity actually a required reviewer, and is self-review allowed?
  #    Read from the API rather than believed: D-191 exists because a control's state was assumed.
  local envjson psr reviewers
  envjson="$(gh api "repos/${REPO_SLUG}/environments/${ENVIRONMENT}" 2>/dev/null)" \
    || { echo "FAIL  cannot read the '${ENVIRONMENT}' environment"; fails=$((fails+1)); envjson='{}'; }
  psr="$(printf '%s' "$envjson" | python3 -c 'import json,sys
d=json.load(sys.stdin)
for r in d.get("protection_rules",[]):
    if r.get("type")=="required_reviewers": print(r.get("prevent_self_review")); break
else: print("none")' 2>/dev/null)"
  reviewers="$(printf '%s' "$envjson" | python3 -c 'import json,sys
d=json.load(sys.stdin)
out=[]
for r in d.get("protection_rules",[]):
    for rv in r.get("reviewers",[]) or []:
        out.append((rv.get("reviewer") or {}).get("login",""))
print(",".join([x for x in out if x]))' 2>/dev/null)"

  if [ "$psr" = "False" ] || [ "$psr" = "false" ]; then
    echo "PASS  prevent_self_review is false — the dispatching actor may approve"
  elif [ "$psr" = "none" ]; then
    echo "PASS  no required_reviewers rule — nothing to approve"
  else
    echo "FAIL  prevent_self_review is '${psr}'; this identity cannot approve a run it dispatched"
    fails=$((fails+1))
  fi

  case ",${reviewers}," in
    *",${who},"*) echo "PASS  '${who}' is a required reviewer (list: ${reviewers})" ;;
    *) echo "FAIL  '${who}' is NOT a required reviewer (list: ${reviewers:-<empty>})"; fails=$((fails+1)) ;;
  esac

  # 3. Is the endpoint itself reachable with this token? A 403 here is the whole question.
  #    Uses the most recent run, whatever its state: an EMPTY list is a successful read.
  local probe rc
  probe="$(gh api "repos/${REPO_SLUG}/actions/runs?per_page=1" --jq '.workflow_runs[0].id' 2>/dev/null)"
  if [ -n "$probe" ]; then
    gh api "repos/${REPO_SLUG}/actions/runs/${probe}/pending_deployments" >/dev/null 2>&1
    rc=$?
    if [ "$rc" -eq 0 ]; then
      echo "PASS  pending_deployments endpoint is readable with this token (probed run ${probe})"
    else
      echo "FAIL  pending_deployments returned a non-zero status for run ${probe}"
      fails=$((fails+1))
    fi
  else
    echo "UNVERIFIED  no workflow run exists to probe the endpoint against"
    fails=$((fails+1))
  fi

  echo
  if [ "$fails" -eq 0 ]; then
    echo "=== ROUTE AVAILABLE: a waiting deployment can be approved from here, no founder step ==="
    return 0
  fi
  echo "=== ROUTE NOT AVAILABLE: ${fails} check(s) failed - this belongs in ops/MANUAL-STEPS.md ==="
  return 1
}

list_waiting() {
  gh api "repos/${REPO_SLUG}/actions/runs?status=waiting&per_page=20" \
    --jq '.workflow_runs[] | "\(.id)  \(.name)  \(.created_at)  \(.html_url)"' 2>/dev/null
}

case "${1:-}" in
  --self-test) self_test; exit $? ;;
  --list)
    out="$(list_waiting)"
    if [ -z "$out" ]; then echo "no runs are waiting on a reviewer"; else echo "$out"; fi
    exit 0 ;;
  ''|-h|--help)
    sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
    exit 0 ;;
esac

RUN_ID="$1"
COMMENT="${2:-Approved by scripts/approve-deployment.sh (CLAUDE.md §8: GitHub gate 1 is automatable; npm approval is NOT and stays with the founder).}"
case "$RUN_ID" in ''|*[!0-9]*) die "run id must be numeric, got '$RUN_ID'" ;; esac

# ASSERT THE THING IS ACTUALLY WAITING BEFORE CLAIMING TO HAVE APPROVED IT.
# An approve against a run with no pending deployment returns success-shaped output and changes
# nothing, which is a completion that resembles one (CLAUDE.md §4.5).
PENDING="$(gh api "repos/${REPO_SLUG}/actions/runs/${RUN_ID}/pending_deployments" 2>/dev/null)"
IDS="$(printf '%s' "$PENDING" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: d=[]
print(" ".join(str((e.get("environment") or {}).get("id")) for e in d if (e.get("environment") or {}).get("id")))' 2>/dev/null)"
if [ -z "${IDS// /}" ]; then
  echo "approve-deployment: run ${RUN_ID} has NO pending deployment. Nothing approved." >&2
  exit 1
fi
echo "run ${RUN_ID} is waiting on environment id(s): ${IDS}"

for eid in $IDS; do
  gh api --method POST "repos/${REPO_SLUG}/actions/runs/${RUN_ID}/pending_deployments" \
    -F "environment_ids[]=${eid}" -f state=approved -f comment="$COMMENT" >/dev/null || die "approval failed for environment ${eid}"
  echo "approved environment ${eid}"
done

# READ BACK. The same discipline §7 condition 2 imposes on a push: do not trust the call.
sleep 3
AFTER="$(gh api "repos/${REPO_SLUG}/actions/runs/${RUN_ID}" --jq '.status' 2>/dev/null)"
echo "run ${RUN_ID} status after approval: ${AFTER:-unknown}"
[ "$AFTER" = "waiting" ] && { echo "STILL WAITING - the approval did not take" >&2; exit 1; }
exit 0
