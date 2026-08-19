#!/usr/bin/env bash
# PRE-PUBLIC SCAN - the hard blocker in front of any visibility change.
#
# Two independent passes over EVERY object in the repository's history, not just the working
# tree, because `git log -p | grep` misses blobs that were only ever reachable from a commit
# that was later amended, and a deleted secret is still a published secret.
#
#   pass 1: gitleaks (the purpose-built scanner), on the full commit graph
#   pass 2: this script's own pattern pass, over every blob in `git rev-list --objects --all`,
#           looking for the things gitleaks does NOT look for: machine-identifying absolute
#           paths, this operator's hostname, private project names, and transcript fragments.
#
# Exit 0 only if BOTH passes find nothing. Anything else is a hard stop.
#
# Usage:
#   ./scripts/pre-public-scan.sh                # scan the current branch's full history
#   SCAN_REF=publish ./scripts/pre-public-scan.sh   # scan one ref's history only
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"
SCAN_REF="${SCAN_REF:-}"
FINDINGS=0
PARTIAL=0
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# This script's OWN OUTPUT is published (verification/pre-public-scan.txt). Printing $ROOT would
# put the operator's home directory into the very artifact that certifies no home directory was
# published. Everything it prints goes through redact().
redact() { sed -e "s|$HOME|~|g" -e "s|$(basename "$HOME")|<user>|g"; }
exec > >(redact) 2>&1

echo "=== PRE-PUBLIC SCAN ==="
echo "captured:  $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "repo:      ~/$(basename "$ROOT")"
echo "scope:     ${SCAN_REF:-ALL REFS}"
echo "head:      $(git rev-parse HEAD)"
echo "gitleaks:  $(gitleaks version 2>/dev/null || echo 'NOT INSTALLED')"
echo

# ---------------------------------------------------------------------------
# PASS 1 - gitleaks over the commit graph
# ---------------------------------------------------------------------------
echo "--- PASS 1: gitleaks, full history ---"
if [ "${SCAN_SKIP_GITLEAKS:-}" = "1" ]; then
  # CI runs pass 2 on every pull request because it needs nothing but python3. Pass 1 needs a
  # third-party binary, and pulling one into a workflow is the supply-chain surface this project
  # pins SHAs to avoid - so gitleaks runs locally, in the pre-push gate, where a human can see it.
  # A run with pass 1 skipped is NOT the publication gate and says so on its last line.
  echo "SKIPPED  gitleaks (SCAN_SKIP_GITLEAKS=1) - this run is the PATTERN PASS ONLY"
  PARTIAL=1
elif ! command -v gitleaks >/dev/null 2>&1; then
  echo "BLOCKER  gitleaks is not installed - pass 1 could not run, so nothing is proven"
  FINDINGS=$((FINDINGS+1))
else
  LOGOPTS="--all"
  [ -n "$SCAN_REF" ] && LOGOPTS="$SCAN_REF"
  if gitleaks git --log-opts="$LOGOPTS" --no-banner --redact \
       --report-format json --report-path "$TMP/gitleaks.json" . >"$TMP/gitleaks.log" 2>&1; then
    N="$(python3 -c "import json;print(len(json.load(open('$TMP/gitleaks.json'))))" 2>/dev/null || echo 0)"
    echo "CLEAN    gitleaks: 0 findings across $(git rev-list --count ${SCAN_REF:---all}) commit(s)"
  else
    N="$(python3 -c "import json;print(len(json.load(open('$TMP/gitleaks.json'))))" 2>/dev/null || echo '?')"
    echo "BLOCKER  gitleaks: $N finding(s)"
    python3 - "$TMP/gitleaks.json" <<'PY' 2>/dev/null || tail -20 "$TMP/gitleaks.log"
import json,sys
for f in json.load(open(sys.argv[1])):
    print(f"           {f.get('RuleID')}  {f.get('File')}:{f.get('StartLine')}  commit={f.get('Commit','')[:10]}")
PY
    FINDINGS=$((FINDINGS+1))
  fi
fi
echo

# ---------------------------------------------------------------------------
# PASS 2 - own pattern pass over every blob in history
# ---------------------------------------------------------------------------
echo "--- PASS 2: pattern scan, every blob in history ---"

# Every pattern is an extended regex. Each one names WHAT it protects, because a scanner whose
# findings nobody can interpret gets waved through.
#
# NOTE what is NOT in this list: the operator's hostname, account name, and private project
# names. This file is published. A scanner that hard-codes the private project name it is
# hunting for has itself published the private project name - and the first run of this script
# caught exactly that, matching its own pattern file. Those strings live in the untracked
# scripts/scan-identity.txt and are matched literally, case-insensitively, and reported redacted.
cat > "$TMP/patterns.txt" <<'PAT'
machine-home-path|/Users/[A-Za-z0-9._-]+/
machine-home-path-win|C:\\\\Users\\\\[A-Za-z0-9._-]+
bonjour-hostname|\b[A-Za-z0-9][A-Za-z0-9-]{2,}\.local\b(?![./A-Za-z0-9])
anthropic-key|sk-ant-[A-Za-z0-9_-]{8,}
openai-key|sk-(proj-)?[A-Za-z0-9]{32,}
google-key|AIza[0-9A-Za-z_-]{30,}
github-token|gh[pousr]_[A-Za-z0-9]{20,}
github-fine-grained|github_pat_[A-Za-z0-9_]{20,}
npm-token|npm_[A-Za-z0-9]{30,}
aws-key|AKIA[0-9A-Z]{16}
slack-token|xox[abprs]-[A-Za-z0-9-]{10,}
private-key-block|-----BEGIN [A-Z ]*PRIVATE KEY-----
jwt|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.
generic-secret-assign|(?i)(api[_-]?key|secret|password|passwd|token)\s*[:=]\s*["'][A-Za-z0-9/+_-]{16,}["']
real-email|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(com|net|org|io|dev|co|me|icloud)\b
PAT

# Operator-identifying strings (hostname, account name) are NOT hard-coded here: this script is
# published, and a scanner that ships the hostname it is looking for has published the hostname.
# They are derived at scan time and, optionally, extended by an untracked scripts/scan-identity.txt
# (one literal string per line).
{
  hostname 2>/dev/null
  scutil --get LocalHostName 2>/dev/null
  scutil --get ComputerName 2>/dev/null
  id -un 2>/dev/null
  basename "$HOME"
  cat "$ROOT/scripts/scan-identity.txt" 2>/dev/null
} | sed 's/[[:space:]]*$//' | grep -vE '^$|^(root|admin|user|runner|ubuntu)$' | sort -u > "$TMP/identity.txt"
echo "         identity strings derived for this machine: $(wc -l < "$TMP/identity.txt" | tr -d ' ') (not printed)"

# Strings that are ALLOWED to match and are not findings: documented example values, the
# scanner's own pattern file, and addresses on domains reserved for documentation.
cat > "$TMP/allow.txt" <<'ALLOW'
/Users/(you|someone|somebody|dev|me|alice|bob)/
example\.(com|org|net|invalid)
\.invalid\b
your-?email
YOUR_
<[a-z-]+@[a-z-]+>
noreply@
scripts/pre-public-scan\.sh
ALLOW

# Collect every blob reachable from the scanned refs, deduplicated by object id.
if [ -n "$SCAN_REF" ]; then
  git rev-list --objects "$SCAN_REF" > "$TMP/objects.txt"
else
  git rev-list --objects --all > "$TMP/objects.txt"
fi
NOBJ="$(wc -l < "$TMP/objects.txt" | tr -d ' ')"

python3 - "$TMP/objects.txt" "$TMP/patterns.txt" "$TMP/allow.txt" "$TMP/identity.txt" <<'PY'
import re, subprocess, sys, collections

objects_file, patterns_file, allow_file, identity_file = sys.argv[1:5]

# Machine-identity strings are matched literally and case-insensitively, and are never echoed
# back: a finding reports the file and the category, never the string that identified it.
identity = [l.strip() for l in open(identity_file) if l.strip()]
identity_rx = [re.compile(re.escape(i), re.I) for i in identity]

pats = []
for line in open(patterns_file):
    line = line.rstrip('\n')
    if not line or line.startswith('#'):
        continue
    name, rx = line.split('|', 1)
    pats.append((name, re.compile(rx)))
allows = [re.compile(l.strip()) for l in open(allow_file) if l.strip()]

# (object id, path) pairs; blobs only, dedup by oid+path.
seen = set()
entries = []
for line in open(objects_file):
    parts = line.rstrip('\n').split(' ', 1)
    if len(parts) != 2:
        continue
    oid, path = parts
    if (oid, path) in seen:
        continue
    seen.add((oid, path))
    entries.append((oid, path))

# batch-read the objects
proc = subprocess.run(['git', 'cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
                      input='\n'.join(o for o, _ in entries) + '\n',
                      capture_output=True, text=True)
kinds = {}
for line in proc.stdout.splitlines():
    f = line.split()
    if len(f) >= 3 and f[1] == 'blob':
        kinds[f[0]] = int(f[2])

findings = collections.defaultdict(list)
scanned = 0
for oid, path in entries:
    size = kinds.get(oid)
    if size is None or size > 4_000_000:
        continue
    raw = subprocess.run(['git', 'cat-file', 'blob', oid], capture_output=True).stdout
    if b'\x00' in raw[:8000]:      # binary
        continue
    text = raw.decode('utf-8', 'replace')
    scanned += 1
    for lineno, line in enumerate(text.splitlines(), 1):
        if any(a.search(line) for a in allows):
            continue
        for name, rx in pats:
            if rx.search(line):
                findings[name].append((path, lineno, oid[:10], line.strip()[:110]))
        if any(r.search(line) for r in identity_rx):
            findings['operator-identity'].append((path, lineno, oid[:10], '<redacted: line matched a machine-identity string>'))

print(f"         blobs scanned: {scanned} (of {len(entries)} objects)")
total = sum(len(v) for v in findings.values())
if total == 0:
    print("CLEAN    pattern scan: 0 findings")
    sys.exit(0)

print(f"BLOCKER  pattern scan: {total} finding(s) in {len(findings)} categor(y/ies)")
for name in sorted(findings):
    hits = findings[name]
    files = sorted({h[0] for h in hits})
    print(f"           [{name}] {len(hits)} hit(s) in {len(files)} file(s):")
    for f in files[:12]:
        n = sum(1 for h in hits if h[0] == f)
        ex = next(h for h in hits if h[0] == f)
        print(f"             {f}  x{n}  (blob {ex[2]} line {ex[1]}): {ex[3]}")
    if len(files) > 12:
        print(f"             ... and {len(files)-12} more file(s)")
sys.exit(1)
PY
P2=$?
[ $P2 -ne 0 ] && FINDINGS=$((FINDINGS+1))

echo
echo "objects considered: $NOBJ"
echo
if [ $FINDINGS -eq 0 ] && [ "$PARTIAL" = "1" ]; then
  echo "=== PATTERN PASS CLEAN - but gitleaks did NOT run. This is NOT the publication gate. ==="
  echo "    Run ./scripts/pre-public-scan.sh with gitleaks installed before any visibility change."
  exit 0
fi
if [ $FINDINGS -eq 0 ]; then
  echo "=== SCAN CLEAN - safe to publish this history ==="
  exit 0
fi
echo "=== SCAN BLOCKED - $FINDINGS pass(es) found something. DO NOT change visibility. ==="
exit 1
