#!/usr/bin/env bash
# SANITISE FOR PUBLICATION - makes the working tree safe to publish, in place and idempotently.
#
# What it removes, and why each one matters on a public repository:
#   * this machine's home directory in absolute paths -> a synthetic persona. Real paths in
#     verification transcripts identify the operator and the machine layout.
#   * this machine's hostname and account name -> removed entirely.
#   * private project names -> removed entirely (read from the untracked scan-identity file).
#   * a third party's email address, captured incidentally from the npm registry -> redacted.
#     It is publicly listed on npm; republishing it in a scraped-for-spam context is still rude.
#   * fake-but-scanner-tripping secret shapes -> fake AND obviously non-matching. The values
#     were always invented, but `sk_test_` + 24 alnum characters matches gitleaks' Stripe rule,
#     and a repository that needs an ignore-file to scan clean has a weaker claim than one that
#     scans clean on its own.
#
# It does NOT touch git history. History is handled by publishing from a fresh orphan branch -
# see scripts/build-publish-tree.sh and DECISIONS.md D-051.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"
CHANGED=0

# Files that are INTERNAL-ONLY and must keep their verbatim text are never touched. They are
# excluded from publication instead (scripts/build-publish-tree.sh), which is the honest fix:
# CLAUDE.md's path rules only work as a fence if they name the real paths, and redacting the
# founder's original spec would make the historical record say something that was never true.
# The first run of this script redacted exactly those files, which is why the list exists.
# The internal-only path list is READ, never restated. Two copies of this regex drifted once
# already; see scripts/internal-only-paths.txt.
internal_only_re() {
  local f="$ROOT/scripts/internal-only-paths.txt"
  [ -f "$f" ] || { echo "FATAL: scripts/internal-only-paths.txt is missing" >&2; exit 2; }
  local frags
  frags="$(sed 's/#.*//' "$f" | sed 's/[[:space:]]*$//' | grep -v '^$' | paste -sd'|' -)"
  [ -n "$frags" ] || { echo "FATAL: scripts/internal-only-paths.txt is empty" >&2; exit 2; }
  printf '^(%s)' "$frags"
}

INTERNAL="$(internal_only_re)"

files() {
  git ls-files | grep -Ev "$INTERNAL" | while read -r f; do
    file --mime "$f" | grep -q 'charset=binary' || echo "$f"
  done
}

apply() { # apply <perl-expr> <label>
  local expr="$1" label="$2" n=0
  while read -r f; do
    before="$(md5 -q "$f" 2>/dev/null || md5sum "$f" | cut -d' ' -f1)"
    perl -0777 -i -pe "$expr" "$f"
    after="$(md5 -q "$f" 2>/dev/null || md5sum "$f" | cut -d' ' -f1)"
    [ "$before" != "$after" ] && n=$((n+1))
  done < <(files)
  printf '  %-46s %d file(s) changed\n' "$label" "$n"
  CHANGED=$((CHANGED+n))
}

echo "=== SANITISE FOR PUBLICATION ==="

# 1. absolute home paths -> a synthetic persona already used throughout the README.
#
# ANY home path, not just THIS account's. It was anchored to `$(id -un)`, which made the rule
# work on the operator's machine and nowhere else: CI ran the same sanitiser, found nothing to
# replace because $HOME there is /home/runner, and the publication rehearsal then caught
# a home directory sitting in two verification artifacts that the local rehearsal had reported
# clean. Same script, same input, two different answers, and the machine-specific one was the
# reassuring one. The rule a published file actually needs is "no home directory belonging to
# anybody", which is machine-independent and strictly stronger.
# TESTS ARE EXEMPT FROM EVERY PATH REWRITE BELOW, AND THIS IS THE REASON.
#
# A test fixture whose SUBJECT is a path shape gets its meaning changed by a rule that rewrites
# that shape. Three of them did, silently, and nothing noticed until condition 4 of the public-push
# gate built and ran the suite of the tree being pushed:
#
#   tests/shlex.test.ts  asserts a write to an agent scratchpad is IN SCOPE. Rule 4 rewrote the
#                        fixture into a path that is not a scratchpad, so the published suite
#                        asserted 'allow' on something the engine correctly denies, and failed.
#   tests/service.test.ts asserts the telemetry content gate CATCHES a home path. Rule 1 rewrote
#                        the fixture into the synthetic persona the gate is meant to accept.
#
# The published repository's own `npm test` went from 526 green to 9 failures, and the cause was
# not a code change at all - it was the sanitiser editing the evidence.
#
# Fixtures are synthetic by construction, so there is nothing in them to redact. And if one ever
# does carry a real identity, the SCANNER still reads tests/ and blocks the publication loudly,
# which is the outcome you want: a rewrite that quietly changes a test's meaning is worse than a
# refusal that says so.
apply 's{/Users/(?!you/)[A-Za-z0-9._-]+/}{/Users/you/}g unless $ARGV =~ m{^(?:\./)?tests/}' "home paths -> /Users/you/"
apply 's{/home/(?!you/)(?!runner/)[A-Za-z0-9._-]+/}{/home/you/}g unless $ARGV =~ m{^(?:\./)?tests/}' "linux home paths -> /home/you/"

# 2. hostname / account name / private project names, from the untracked identity file.
if [ -f scripts/scan-identity.txt ]; then
  while IFS= read -r s; do
    case "$s" in ''|'#'*) continue ;; esac
    esc="$(printf '%s' "$s" | perl -pe 's/([^A-Za-z0-9_])/\\$1/g')"
    apply "s/$esc/REDACTED/gi unless \$ARGV =~ m{^(?:\./)?tests/}" "identity string -> REDACTED"
  done < scripts/scan-identity.txt
fi

# 3. a third party's email address captured from the npm registry.
apply 's{\b[A-Za-z0-9._%+-]+\@[A-Za-z0-9.-]+\.(?:com|net|org|io|co|me)\b(?!\w)}{<email-redacted>}g unless $ARGV =~ m{(SECURITY|CONTRIBUTING|CODE_OF_CONDUCT)\.md$|^(?:\./)?tests/}' \
      "third-party emails -> <email-redacted>"

# 4. agent-harness scratchpad paths, which encode the home directory a second way
#    (/private/tmp/claude-<uid>/-Users-<name>-dev-<repo>/...). The sanitiser missed these on its
#    first pass because they are not literally "/Users/<name>/" - the scanner found them.
apply 's{/private/tmp/claude-\d+/-Users-[A-Za-z0-9._-]+-dev-[A-Za-z0-9._-]+/[0-9a-f-]+/scratchpad}{/tmp/usewarden-clean-machine}g unless $ARGV =~ m{^(?:\./)?tests/}' \
      "harness scratchpad paths -> /tmp/..."

# 4b. THE HOME DIRECTORY ENCODED A THIRD WAY: separator-mangled, as in
#     `_Users_you_.claude_settings.json`.
#
#     Usewarden's own backup naming produces this - `usewarden init` flattens the absolute path of
#     each config it backs up into a single filename by replacing every `/` with `_`, so the
#     operator's home directory ends up inside a FILENAME with no slashes in it at all. Rule 1 only
#     matches `/Users/<name>/` and rule 4 only matches the harness form, so both walked straight
#     past it, and the string reached a verification artifact that the publication rehearsal then
#     refused (D-246).
#
#     That is the THIRD distinct encoding of the same secret, and the second time the scanner
#     caught what the sanitiser missed. The lesson is written down rather than just patched: the
#     scanner derives identity strings independently and is the backstop precisely because this
#     list will never be complete. A new tool that serialises a path in a new way adds a new form,
#     and the rehearsal is what makes that a blocked publish instead of a leak.
apply 's{_Users_[A-Za-z0-9.-]+_}{_Users_you_}g unless $ARGV =~ m{^(?:\./)?tests/}' "separator-mangled home paths -> _Users_you_"

# 5. synthetic personas that are not on the allowlist, normalised to ones that are.
apply 's{/Users/you/}{/Users/you/}g' "synthetic persona /Users/x -> /Users/someone"

# 6. the bare account name where it appears as a FIELD rather than as part of a path -
#    `ls -l` prints "owner group", and a captured `ls -l` in a verification artifact carries the
#    account name with no slash anywhere near it. Applied only under verification/, where every
#    byte is machine output and a blanket substitution cannot damage prose.
apply 's{\b'"$(id -un)"'\b}{user}g if $ARGV =~ m{^verification/}' \
      "account name in captured output -> user"

# 7. secret-SHAPED fake values -> fake values that no scanner mistakes for real ones.
apply 's{sk_test_FAKE-not-a-real-key-+}{sk_test_FAKE-not-a-real-key-}g' "fake Stripe keys -> non-matching shape"

echo
echo "$CHANGED file-edit(s) applied. Re-run ./scripts/pre-public-scan.sh to confirm."
