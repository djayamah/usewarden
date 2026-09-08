#!/usr/bin/env bash
# SCAN A FILE OF PROSE THAT IS ABOUT TO BE PUBLISHED SOMEWHERE THAT IS NOT A GIT PUSH.
#
# ---------------------------------------------------------------------------------------------
# THE GAP THIS CLOSES
# ---------------------------------------------------------------------------------------------
# Every publication control in this repository scans a GIT REF: `pre-public-scan.sh` walks blobs
# and commits, `publish-rehearsal.sh` builds a tree, `scan-published-head.sh` fetches what is live.
# All of them assume the thing being published is a commit.
#
# The 2026-08-22 and 2026-08-24 amendments made that assumption false. A GitHub Discussion, a
# Discussion comment, a Release body and an issue comment are all published text that never passes
# through a ref — and the worst case is specific rather than theoretical:
#
#   `launch/` is in `scripts/internal-only-paths.txt`. Files there are DROPPED from the published
#   tree, so they have never been scanned by anything, because nothing ever intended to publish
#   them. `launch/writeups/` is eight long prose pieces about this project's own defects, written
#   with no expectation that they would be read by the scanner — and they are exactly what the
#   founder now wants published.
#
# So the one category of file least likely to be clean is the category now most likely to be
# posted. This scans it before it goes anywhere.
#
#     ./scripts/scan-text-for-publication.sh FILE [FILE...]
#
# Exit 0 = clean. Exit 1 = findings, do not publish. Exit 2 = could not scan, which is also not a
# pass (CLAUDE.md §4.4).
#
# It reuses `scripts/scan-identity.txt` — the same untracked literals `pre-public-scan.sh` uses —
# and derives the machine and account names the same way, so the two cannot drift into disagreeing
# about what counts as an identity. Findings are REDACTED in the output for the identity class,
# for the same reason that file is untracked: printing them puts them somewhere else.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT" || exit 2

[ "$#" -ge 1 ] || { echo "usage: $0 FILE [FILE...]" >&2; exit 2; }
for f in "$@"; do
  [ -r "$f" ] || { echo "UNVERIFIED: cannot read $f - not scanned, which is not a pass." >&2; exit 2; }
done

IDENTITY_FILE="$ROOT/scripts/scan-identity.txt"
[ -r "$IDENTITY_FILE" ] || {
  echo "UNVERIFIED: $IDENTITY_FILE is missing. The identity literals are untracked by design;" >&2
  echo "            without them this scan is weaker than it looks, so it refuses to run." >&2
  exit 2; }

LOCALHOST="$(scutil --get LocalHostName 2>/dev/null || true)"
export SCAN_LOCALHOST="$LOCALHOST"

python3 - "$IDENTITY_FILE" "$@" <<'PY'
import os, re, subprocess, sys

identity_file, files = sys.argv[1], sys.argv[2:]

literals = [l.strip() for l in open(identity_file) if l.strip() and not l.startswith('#')]
for extra in (os.environ.get('USER', ''),
              subprocess.run(['hostname'], capture_output=True, text=True).stdout.strip(),
              os.environ.get('SCAN_LOCALHOST', ''),
              os.path.basename(os.path.expanduser('~'))):
    if extra and len(extra) > 2 and extra not in literals:
        literals.append(extra)

# Classes beyond the literals. Each is something that has ALREADY been found in this repository at
# least once, rather than a list of everything that could theoretically be sensitive.
CLASSES = [
    (r'/Users/[A-Za-z0-9._-]+',                          'absolute home path',      True),
    (r'\b[A-Za-z0-9-]+\.local\b',                        '.local hostname',         True),
    (r'(?i)(sk-|ghp_|gho_|github_pat_|AIza|npm_)[A-Za-z0-9_-]{8,}', 'credential-shaped token', True),
    (r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b', 'email address',        False),
]
# Addresses that are deliberately public. An alarm that fires on the security contact is an alarm
# nobody reads (D-142).
EMAIL_ALLOW = re.compile(r'(?i)@(example\.(com|org|net)|users\.noreply\.github\.com)$|'
                         r'^(security|noreply)@')

findings = 0
scanned = 0
for path in files:
    text = open(path, encoding='utf-8', errors='replace').read()
    scanned += 1
    for lit in literals:
        for m in re.finditer(re.escape(lit), text, re.I):
            ln = text[:m.start()].count('\n') + 1
            print(f'FINDING  {path}:{ln}  [operator-identity]  <redacted>')
            findings += 1
    for rx, label, redact in CLASSES:
        for m in re.finditer(rx, text):
            hit = m.group(0)
            if label == 'email address' and EMAIL_ALLOW.search(hit):
                continue
            ln = text[:m.start()].count('\n') + 1
            shown = '<redacted>' if redact else hit
            print(f'FINDING  {path}:{ln}  [{label}]  {shown}')
            findings += 1

print()
print(f'files scanned: {scanned}   identity literals: {len(literals)}   findings: {findings}')
if findings:
    print('=== BLOCKED - do not publish this text ===')
    sys.exit(1)
print('=== CLEAN - safe to publish this text ===')
PY
