#!/usr/bin/env bash
# LIVE JUDGE CHECK — runs ops/JUDGE-LIVE-CHECK.md against a metered provider, with the API key
# read from the macOS Keychain and never seen by anything else.
#
# ============================================================================================
# THE ONE THING THIS SCRIPT IS FOR
# ============================================================================================
# CLAUDE.md §2 forbids handling, echoing, logging, or writing any API key, and says to redact
# BY CONSTRUCTION rather than by remembering to redact afterwards. So:
#
#   * The key is read from the Keychain by a command substitution consumed directly by a
#     ONE-COMMAND environment assignment: `GEMINI_API_KEY="$(security ...)" node ...`. Bash
#     scopes that assignment to the single command it prefixes. There is no `export`, no shell
#     variable, and nothing to leak into the parent shell, a later command, or a `set` dump —
#     the value never becomes a variable at all.
#   * The assignment prefix uses a LITERAL variable name, never `env NAME=value`. `env` would
#     put the value in argv, where `ps -ww` can read it. This form puts it straight into the
#     child's environment block.
#   * It is never written to a file, a log, or a temp path.
#   * `set -x` is NEVER used here, and a test asserts it never appears. Tracing a line carrying
#     a command substitution is precisely how a key reaches a terminal transcript.
#   * Both of the child's streams are piped through `scrub`, which redacts BY SHAPE. It does not
#     need to know the key's value to remove it — so it cannot be defeated by the value changing,
#     and it also catches a *different* provider's key that a vendor error echoed back.
#
# The existence probe measures the key's LENGTH and nothing else. A length is not a secret; it is
# the only property of the value this script is ever allowed to learn.
#
# Usage:
#   ./scripts/judge-live.sh                 # run the check, human output
#   ./scripts/judge-live.sh --json          # machine-readable, still scrubbed
#   ./scripts/judge-live.sh --scrub-stdin   # filter mode: scrub stdin to stdout (used by tests)
#
# Environment (all optional):
#   USEWARDEN_KEYCHAIN_SERVICE   Keychain service name  (default: usewarden-gemini)
#   USEWARDEN_KEYCHAIN_ACCOUNT   Keychain account name  (default: $USER)
#   USEWARDEN_JUDGE_PROVIDER     gemini | anthropic | openai  (default: gemini)
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

SERVICE="${USEWARDEN_KEYCHAIN_SERVICE:-usewarden-gemini}"
ACCOUNT="${USEWARDEN_KEYCHAIN_ACCOUNT:-${USER:-}}"
PROVIDER="${USEWARDEN_JUDGE_PROVIDER:-gemini}"

# ---------------------------------------------------------------------------------------------
# scrub — redact anything key-SHAPED on every stream that leaves this script.
#
# By shape, deliberately, not by value. A scrubber that substituted the known key would have to
# hold the known key in a variable, which is the single thing this script exists to avoid.
# ---------------------------------------------------------------------------------------------
scrub() {
  LC_ALL=C sed -E \
    -e 's/AIza[0-9A-Za-z_-]{30,}/[REDACTED-GOOGLE-KEY]/g' \
    -e 's/AQ\.[A-Za-z0-9_-]{20,}/[REDACTED-GOOGLE-KEY]/g' \
    -e 's/sk-ant-[A-Za-z0-9_-]{8,}/[REDACTED-ANTHROPIC-KEY]/g' \
    -e 's/sk-(proj-)?[A-Za-z0-9_-]{16,}/[REDACTED-OPENAI-KEY]/g' \
    -e 's/gh[pousr]_[A-Za-z0-9]{16,}/[REDACTED-GITHUB-TOKEN]/g' \
    -e 's/github_pat_[A-Za-z0-9_]{20,}/[REDACTED-GITHUB-TOKEN]/g' \
    -e 's/npm_[A-Za-z0-9]{20,}/[REDACTED-NPM-TOKEN]/g' \
    -e 's/AKIA[0-9A-Z]{16}/[REDACTED-AWS-KEY]/g' \
    -e 's/xox[baprs]-[A-Za-z0-9-]{10,}/[REDACTED-SLACK-TOKEN]/g' \
    -e 's/(AIza|AQ\.|sk-ant-|sk-|ghp_)[A-Za-z0-9_-]{8,}/[REDACTED-POSSIBLE-KEY]/g'
}

# Filter mode: lets a test prove the scrubber with no Keychain entry and no network call.
if [ "${1:-}" = "--scrub-stdin" ]; then
  scrub
  exit 0
fi

# Every message this script emits goes through scrub, including its own failures: a `security`
# error string is written by someone else and is not ours to trust.
die() {
  printf '%s\n' "$@" | scrub >&2
  exit "${DIE_CODE:-1}"
}

# ---------------------------------------------------------------------------------------------
# 1. Fail LOUDLY when the setup is wrong. None of these may degrade into "no judge available",
#    which reads as a configuration choice rather than a broken setup.
# ---------------------------------------------------------------------------------------------
case "$PROVIDER" in
  gemini|anthropic|openai) ;;
  *) DIE_CODE=3 die "judge-live: FAILED - unknown provider '$PROVIDER'. Use gemini, anthropic, or openai." ;;
esac

# Checked BEFORE the Keychain binary, because it needs no Keychain: it is pure argument
# validation. Behind the `security` check it was unreachable on any machine without one, so the
# only platform where that failure could be tested was the platform least likely to hit it.
[ -n "$ACCOUNT" ] || DIE_CODE=3 die \
  "judge-live: FAILED - no Keychain account name." \
  "            \$USER is empty and USEWARDEN_KEYCHAIN_ACCOUNT was not set."

# EVERY setup failure says that nothing ran. "Something went wrong" and "nothing happened" are
# different sentences, and only the second one tells you no request was made and no key was read.
# This branch was missing that line, which CI on Linux found and macOS never could.
command -v security >/dev/null 2>&1 || DIE_CODE=3 die \
  "judge-live: FAILED - the 'security' command is not on PATH." \
  "            This script reads the API key from the macOS Keychain and has no other source." \
  "            Nothing was run and no request was made." \
  "            Elsewhere, run 'node dist/src/cli.js judge-check' with the key in the environment" \
  "            yourself; see ops/JUDGE-LIVE-CHECK.md."

[ -f "$REPO/dist/src/cli.js" ] || DIE_CODE=3 die \
  "judge-live: FAILED - $REPO/dist/src/cli.js does not exist. Run 'npm run build' first."

security find-generic-password -s "$SERVICE" -a "$ACCOUNT" >/dev/null 2>&1 || DIE_CODE=3 die \
  "judge-live: FAILED - no Keychain entry for service '$SERVICE', account '$ACCOUNT'." \
  "            Nothing was run and no request was made." \
  "            Add it (the value is never echoed, and this script never learns it):" \
  "                security add-generic-password -s '$SERVICE' -a '$ACCOUNT' -w" \
  "            and paste the key at the prompt."

# The ONLY property of the value this script is permitted to learn. A length is not a secret.
KEY_LEN="$(security find-generic-password -w -s "$SERVICE" -a "$ACCOUNT" 2>/dev/null \
  | LC_ALL=C tr -d '\n' | LC_ALL=C wc -c | tr -d ' ')"
if [ -z "$KEY_LEN" ] || [ "$KEY_LEN" -lt 16 ]; then
  DIE_CODE=3 die \
    "judge-live: FAILED - Keychain entry '$SERVICE' exists but holds ${KEY_LEN:-0} characters." \
    "            That is too short to be an API key. Nothing was run and no request was made." \
    "            Re-add it: security add-generic-password -U -s '$SERVICE' -a '$ACCOUNT' -w"
fi

printf '%s\n' \
  "judge-live: key source    macOS Keychain, service '$SERVICE', account '$ACCOUNT'" \
  "judge-live: key length    $KEY_LEN characters (the value is never read by this script)" \
  "judge-live: provider      $PROVIDER" \
  "judge-live: ceiling       USEWARDEN_JUDGE_MAX_USD=0.25, USEWARDEN_JUDGE_NO_LOCAL=1" \
  "" | scrub

# ---------------------------------------------------------------------------------------------
# 2. Run it.
#
# One branch per provider so the assignment prefix can use a LITERAL variable name. Bash has no
# dynamic form of `NAME=value cmd`, and the alternative — `env "$NAME=$value" cmd` — would put
# the key in argv. Three near-identical lines are the price of keeping it out of `ps`, and that
# is a price worth paying.
#
# `2>&1 | scrub` sends BOTH streams through the redactor. The exit status is taken from
# PIPESTATUS[0]; the pipeline's own status belongs to sed.
# ---------------------------------------------------------------------------------------------
CLI="$REPO/dist/src/cli.js"
set +e
case "$PROVIDER" in
  gemini)
    GEMINI_API_KEY="$(security find-generic-password -w -s "$SERVICE" -a "$ACCOUNT")" \
    USEWARDEN_JUDGE_NO_LOCAL=1 USEWARDEN_JUDGE_MAX_USD=0.25 \
      node "$CLI" judge-check "$@" 2>&1 | scrub
    ;;
  anthropic)
    ANTHROPIC_API_KEY="$(security find-generic-password -w -s "$SERVICE" -a "$ACCOUNT")" \
    USEWARDEN_JUDGE_NO_LOCAL=1 USEWARDEN_JUDGE_MAX_USD=0.25 \
      node "$CLI" judge-check "$@" 2>&1 | scrub
    ;;
  openai)
    OPENAI_API_KEY="$(security find-generic-password -w -s "$SERVICE" -a "$ACCOUNT")" \
    USEWARDEN_JUDGE_NO_LOCAL=1 USEWARDEN_JUDGE_MAX_USD=0.25 \
      node "$CLI" judge-check "$@" 2>&1 | scrub
    ;;
esac
RC="${PIPESTATUS[0]}"
set -e

exit "$RC"
