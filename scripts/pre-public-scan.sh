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
# TWO SCOPES, because they answer different questions and only one of them is actionable:
#
#   --scope=tree      the working tree as it stands. Every finding here is something a commit
#                     could still be stopped from carrying, so this scope has NO baseline and
#                     must be clean, always. This is the per-push gate.
#   --scope=history   every blob ever reachable (the default). History is immutable, so a
#                     finding here cannot be fixed by editing a file. This scope is a human-read
#                     diagnostic, NOT the per-push gate - see the note below on what publication
#                     actually carries.
#
# WHAT THE PUBLICATION GATE ACTUALLY IS (and what it is not):
#   Publication does not push this history. scripts/build-publish-tree.sh writes a single commit
#   containing the public subset of HEAD (DECISIONS.md D-051 - a rewrite leaves the old blobs
#   fetchable by SHA on a public repo, so a fresh single-commit history is used instead). The
#   gate that matters is therefore `SCAN_REF=publish` over THAT ref, at full strictness, after
#   scripts/sanitise-for-publication.sh has run. scripts/publish-rehearsal.sh does exactly that
#   and is what CI runs. Scanning this repository's own private history and refusing to be green
#   would gate on a question publication never asks - and a blocking gate that can never go green
#   gets ignored, which is worse than no gate at all.
#
# Usage:
#   ./scripts/pre-public-scan.sh                     # full history, baseline applied
#   ./scripts/pre-public-scan.sh --scope=tree        # working tree only, no baseline
#   ./scripts/pre-public-scan.sh --report=findings.tsv   # machine-readable list of every hit
#   SCAN_REF=publish ./scripts/pre-public-scan.sh    # scan one ref's history only
#   SCAN_REF=public/main ./scripts/pre-public-scan.sh --scope=tree --classes=identity
#                                                    # scan the FILES OF THAT REF - what is
#                                                    # published RIGHT NOW, not how it got there
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"
SCAN_REF="${SCAN_REF:-}"
SCAN_SCOPE="${SCAN_SCOPE:-history}"
SCAN_CLASSES="${SCAN_CLASSES:-all}"
SCAN_REPORT=""
for arg in "$@"; do
  case "$arg" in
    --scope=tree|--scope=history) SCAN_SCOPE="${arg#--scope=}" ;;
    --classes=credentials|--classes=identity|--classes=all) SCAN_CLASSES="${arg#--classes=}" ;;
    --report=*) SCAN_REPORT="${arg#--report=}" ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done
# `--scope=tree` alone means the working tree; `--scope=tree` WITH a ref means that ref's files.
# The distinction is computed once, here, so the header cannot describe a different scan from the
# one that runs.
PYSCOPE="$SCAN_SCOPE"
[ "$SCAN_SCOPE" = "tree" ] && [ -n "$SCAN_REF" ] && PYSCOPE="ref-tree"
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
case "$PYSCOPE" in
  ref-tree) echo "scope:     the FILES OF $SCAN_REF (what that ref publishes today, not its history)" ;;
  tree)     echo "scope:     tree (the tracked working-tree files on disk)" ;;
  *)        echo "scope:     history (${SCAN_REF:-ALL REFS})" ;;
esac
echo "classes:   $SCAN_CLASSES"
echo "head:      $(git rev-parse HEAD)"
echo "gitleaks:  $(gitleaks version 2>/dev/null || echo 'NOT INSTALLED')"
echo

# ---------------------------------------------------------------------------
# PASS 1 - gitleaks over the commit graph
# ---------------------------------------------------------------------------
echo "--- PASS 1: gitleaks, full history ---"
if [ "$SCAN_CLASSES" = "identity" ]; then
  echo "SKIPPED  gitleaks - this run is --classes=identity, and gitleaks looks for credentials"
  PARTIAL=1
elif [ "$SCAN_SCOPE" = "tree" ]; then
  # gitleaks here is a HISTORY scanner. Running it against a working tree would answer a
  # different question and report it under the same heading, which is how a gate starts lying.
  if [ "$PYSCOPE" = "ref-tree" ]; then
    echo "SKIPPED  gitleaks - this run asks what $SCAN_REF PUBLISHES, and gitleaks answers a"
    echo "         history question. A clean tree says nothing about the history behind it."
  else
    echo "SKIPPED  gitleaks - this run is --scope=tree, which is the per-push gate, not publication"
  fi
  PARTIAL=1
elif [ "${SCAN_SKIP_GITLEAKS:-}" = "1" ]; then
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
if [ "$PYSCOPE" = "ref-tree" ]; then
  echo "--- PASS 2: pattern scan, every file in the tree of $SCAN_REF ---"
elif [ "$PYSCOPE" = "tree" ]; then
  echo "--- PASS 2: pattern scan, every tracked file on disk ---"
else
  echo "--- PASS 2: pattern scan, every blob in history ---"
fi

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
bonjour-hostname|(?<![.\w-])[A-Za-z0-9][A-Za-z0-9-]{2,}\.local\b(?![./A-Za-z0-9])
anthropic-key|sk-ant-[A-Za-z0-9_-]{8,}
openai-key|sk-(proj-)?[A-Za-z0-9]{32,}
google-key|AIza[0-9A-Za-z_-]{30,}
google-key-aq|AQ\.[A-Za-z0-9_-]{20,}
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

# ALLOWS ARE MATCHED AGAINST THE MATCHED TEXT, NOT AGAINST THE WHOLE LINE.
#
# They used to be line-level: if any allow matched anywhere on a line, every pattern was skipped
# for that line. That is the scanner-too-broad failure inverted - one benign token on a line
# exempted a real key sitting beside it. An allow now has to match the thing that was actually
# found. This is the fourth time this repository has had to make a scanner distinguish USING a
# dangerous value from NAMING one (DECISIONS.md D-091); the rule is the same each time - scope by
# consequence.
#
# NOTE FOR THE NEXT PERSON TEMPTED TO ADD ONE HERE. scripts/scan-published-head.sh plants identity
# strings in order to prove this scanner blocks on them, so the rehearsal blocked on the prover -
# the fifth outing of D-091. The first fix was an allow entry for the synthetic prefix, and it was
# WRONG: the planted home-path string carried that same prefix, so the allow exempted the sabotage
# as well as the script, and half the self-test silently stopped testing anything. The self-test
# caught it, which is the only reason it was a ten-minute mistake instead of a permanent one.
#
# The correct fix was to stop the prover containing the literals at all - it assembles them at run
# time from fragments, so the scanner has nothing to find in the script and everything to find in
# what the script plants. An allow entry weakens the rule for every file; assembling at run time
# weakens nothing.
cat > "$TMP/allow.txt" <<'ALLOW'
/Users/(you|someone|somebody|dev|me|alice|bob)/
example\.(com|org|net|invalid)
\.invalid\b
your-?email
YOUR_
<[a-z-]+@[a-z-]+>
noreply@
^git@[A-Za-z0-9.-]+$
ALLOW

# Paths whose CONTENT is exempt, because the file's whole purpose is to carry the shapes being
# hunted. Kept separate from the match allows: a path exemption is much stronger, so it is
# spelled out per path rather than falling out of a regex that happened to match a line.
cat > "$TMP/pathallow.txt" <<'PATHALLOW'
^scripts/pre-public-scan\.sh$
PATHALLOW

# Collect what is to be scanned. In tree scope that is the tracked working-tree files, read from
# disk; in history scope it is every blob reachable from the scanned refs, deduplicated by oid.
#
# THREE scopes, because "is this repository clean" is three different questions:
#   history          - every blob ever reachable from the ref. What a git-history archaeologist
#                      can recover. Immutable: a bad blob here is permanent short of a rewrite.
#   tree (no ref)    - the tracked files on disk right now. The per-push gate.
#   tree (with ref)  - the FILES OF THAT REF. This is the only one that answers "what does a
#                      person who visits the repository see today", and it is the question that
#                      went unasked until D-140 - see scripts/scan-published-head.sh.
if [ "$PYSCOPE" = "ref-tree" ]; then
  git ls-tree -r --format='%(objectname) %(path)' "$SCAN_REF" > "$TMP/objects.txt" || {
    echo "FATAL: could not list the tree of '$SCAN_REF'" >&2; exit 2; }
  [ -s "$TMP/objects.txt" ] || { echo "FATAL: '$SCAN_REF' has an empty tree - refusing to report a" \
    "vacuous CLEAN" >&2; exit 2; }
elif [ "$SCAN_SCOPE" = "tree" ]; then
  git ls-files -z | tr '\0' '\n' | sed 's/^/TREE /' > "$TMP/objects.txt"
elif [ -n "$SCAN_REF" ]; then
  git rev-list --objects "$SCAN_REF" > "$TMP/objects.txt"
else
  git rev-list --objects --all > "$TMP/objects.txt"
fi
NOBJ="$(wc -l < "$TMP/objects.txt" | tr -d ' ')"
# The third consumer of the internal-only list. Identity findings inside these paths are not
# reported, because publication DROPS these paths rather than redacting them - they are supposed
# to name the real machine. Credential findings are still reported in them: a key in CLAUDE.md is
# a leaked key whether or not CLAUDE.md is ever published.
sed 's/#.*//' "$ROOT/scripts/internal-only-paths.txt" | sed 's/[[:space:]]*$//' | grep -v '^$' \
  > "$TMP/internal.txt" || true
[ -s "$TMP/internal.txt" ] || { echo "FATAL: scripts/internal-only-paths.txt is empty or missing" >&2; exit 2; }

python3 - "$TMP/objects.txt" "$TMP/patterns.txt" "$TMP/allow.txt" "$TMP/identity.txt" \
         "$TMP/pathallow.txt" "$PYSCOPE" "${SCAN_REPORT:-}" \
         "$TMP/internal.txt" "$SCAN_CLASSES" <<'PY'
import re, subprocess, sys, collections, os

(objects_file, patterns_file, allow_file, identity_file,
 pathallow_file, scope, report_file,
 internal_file, classes) = sys.argv[1:10]

# Anchored at the path start, exactly as the publisher anchors it.
internal_frags = [l.strip() for l in open(internal_file) if l.strip()]
internal_rx = re.compile('^(' + '|'.join(internal_frags) + ')')

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
path_allows = [re.compile(l.strip()) for l in open(pathallow_file) if l.strip()]

# --- What counts as a credential, and what is merely credential-SHAPED ---------------------
#
# A test fixture proving that redaction works has to contain something with the shape of a key.
# Blocking the repository because the redaction test contains `sk-ant-api03-0000...` blocks the
# proof that redaction works, which is the fourth outing of D-091 in this codebase. So the
# question asked here is the consequential one: could this string authenticate to anything?
#
# Two ways to be sure it could not, and both are needed:
#   1. it says so - DEADBEEF, NOT-A-REAL-KEY, example, placeholder;
#   2. it has almost no entropy - a real 32+ character key does not have four distinct
#      characters in it. `0000000000000000` does.
# Neither test is applied to anything that is not a credential pattern: a home directory path
# with low entropy is still a home directory path.
CREDENTIAL_PATTERNS = {
    'anthropic-key', 'openai-key', 'google-key', 'google-key-aq', 'github-token',
    'github-fine-grained', 'npm-token', 'aws-key', 'slack-token', 'jwt',
    'generic-secret-assign', 'private-key-block',
}
# Everything else this scanner looks for identifies a PERSON or a MACHINE rather than granting
# access to anything. The two classes get different gates because they have different fixes: a
# credential is revoked and must never appear anywhere, in any repository, public or private; an
# absolute path is REDACTED AT PUBLICATION by scripts/sanitise-for-publication.sh and is expected
# to be present in a private working tree that documents a real machine.
IDENTITY_PATTERNS = {
    'machine-home-path', 'machine-home-path-win', 'bonjour-hostname', 'real-email',
    'operator-identity',
}

def in_class(name: str) -> bool:
    if classes == 'all':
        return True
    if classes == 'credentials':
        return name in CREDENTIAL_PATTERNS
    return name not in CREDENTIAL_PATTERNS
SYNTHETIC_MARKERS = re.compile(
    r'(?i)not-?a-?real|deadbeef|cafebabe|example|placeholder|dummy|fake|test-?only|redacted|'
    r'<[a-z][a-z-]*>|\bxxxx')
PREFIXES = re.compile(
    r'^(sk-ant-api\d+-|sk-ant-|sk-proj-|sk-|AIzaSy|AIza|AQ\.|gh[pousr]_|github_pat_|npm_|AKIA|'
    r'xox[abprs]-|eyJ)')

def is_synthetic(matched: str) -> bool:
    if SYNTHETIC_MARKERS.search(matched):
        return True
    body = PREFIXES.sub('', matched)
    core = re.sub(r'[^A-Za-z0-9]', '', body)
    return len(set(core)) < 6

def allowed(name: str, matched: str) -> bool:
    if any(a.search(matched) for a in allows):
        return True
    return name in CREDENTIAL_PATTERNS and is_synthetic(matched)

# (object id, path) pairs; blobs only, dedup by oid+path. In tree scope the "oid" is the literal
# string TREE and the content is read from disk.
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
    if any(pa.search(path) for pa in path_allows):
        continue
    entries.append((oid, path))

kinds = {}
if scope != 'tree':
    proc = subprocess.run(['git', 'cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
                          input='\n'.join(o for o, _ in entries) + '\n',
                          capture_output=True, text=True)
    for line in proc.stdout.splitlines():
        f = line.split()
        if len(f) >= 3 and f[1] == 'blob':
            kinds[f[0]] = int(f[2])

findings = collections.defaultdict(list)
internal_skipped = 0
scanned = 0
report = open(report_file, 'w') if report_file else None

for oid, path in entries:
    if scope == 'tree':
        try:
            if os.path.getsize(path) > 4_000_000:
                continue
            raw = open(path, 'rb').read()
        except OSError:
            continue
    else:
        size = kinds.get(oid)
        if size is None or size > 4_000_000:
            continue
        raw = subprocess.run(['git', 'cat-file', 'blob', oid], capture_output=True).stdout
    if b'\x00' in raw[:8000]:      # binary
        continue
    text = raw.decode('utf-8', 'replace')
    scanned += 1
    for lineno, line in enumerate(text.splitlines(), 1):
        hits = []
        for name, rx in pats:
            for m in rx.finditer(line):
                if not allowed(name, m.group(0)):
                    hits.append(name)
                    break
        if any(r.search(line) for r in identity_rx):
            hits.append('operator-identity')
        for name in hits:
            if not in_class(name):
                continue
            # Identity in an internal-only path is not a finding: publication drops the whole
            # file. Counted and printed as a total, never silently dropped - a scanner that
            # quietly ignores a category is a scanner nobody can calibrate.
            if name not in CREDENTIAL_PATTERNS and internal_rx.search(path):
                internal_skipped += 1
                continue
            if report:
                report.write('\t'.join((name, oid[:10], path)) + '\n')
            shown = ('<redacted: line matched a machine-identity string>'
                     if name == 'operator-identity' else line.strip()[:110])
            findings[name].append((path, lineno, oid[:10], shown))

if report:
    report.close()

unit = 'file' if scope in ('tree', 'ref-tree') else 'blob'
print(f"         {unit}s scanned: {scanned} (of {len(entries)} candidates)")
if internal_skipped:
    print(f"         identity hits inside internal-only paths: {internal_skipped} "
          f"(dropped at publication, not redacted - scripts/internal-only-paths.txt)")
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

# ---------------------------------------------------------------------------
# PASS 3 - COMMIT METADATA
# ---------------------------------------------------------------------------
#
# Passes 1 and 2 read BLOBS. Every scan in this repository read blobs. Nothing ever read the
# commit headers, and `git` puts an identity in every one of them.
#
# The public repository's root commit is authored and committed by
# `<account>@<machine-name>.local` - the Mac's Bonjour hostname, which is precisely the
# `bonjour-hostname` pattern pass 2 hunts for inside files. It got there because
# scripts/build-publish-tree.sh calls `git commit-tree`, which silently uses whatever identity
# the machine's git config happens to carry. No scan could see it, because no scan looked at
# that surface at all.
#
# Same lesson as D-140 rotated ninety degrees: there, every scan pointed at the wrong POINT IN
# TIME; here, every scan pointed at the wrong PART OF THE OBJECT.
#
# WHAT THIS FLAGS, AND WHAT IT DELIBERATELY DOES NOT
#
#   flagged   an author/committer name or email containing a string derived from THIS machine
#             (hostname, LocalHostName, ComputerName, account name) - accidental, nobody chose it
#   flagged   any email in the `.local` TLD - a Bonjour hostname, never a deliverable address,
#             and always a machine name rather than a person's choice
#   NOT       an ordinary email address. Publishing commits under your own email is what git is
#             for. A rule that flagged it would be red forever on every repository on earth, and
#             a rule that is always red is a rule nobody reads.
echo "--- PASS 3: commit metadata (author and committer identity) ---"
if [ "$SCAN_CLASSES" = "credentials" ]; then
  echo "SKIPPED  pass 3 is identity-class, and this run is --classes=credentials"
elif [ "$PYSCOPE" = "tree" ]; then
  echo "SKIPPED  pass 3 needs commits, and --scope=tree with no ref has none to read"
else
  # SCOPE MATTERS HERE, and getting it wrong once already cost a green build.
  #
  # In ref-tree scope the question is "what does this ref publish TODAY", so pass 3 reads the TIP
  # COMMIT ONLY - that commit's header is part of what the ref serves, and its ancestors are
  # history. Reading the whole ancestry here would fold the two questions back together, which is
  # exactly the defect D-142 split apart: the published-head control went red over a commit from
  # before the fix, in the control built to stop that happening.
  #
  # The ancestry is not ignored - it is the history scope's question, and verify-hardening.sh has
  # a row for it. One scan, one question.
  if [ "$PYSCOPE" = "ref-tree" ]; then
    META_RANGE="-1 $SCAN_REF"
    echo "         scope: the tip commit only - ancestry is a history question, see --scope=history"
  else
    META_RANGE="${SCAN_REF:---all}"
  fi
  META_HITS=0
  META_TOTAL=0
  # One record per commit, tab-separated, NUL-delimited so a name containing a newline cannot
  # forge a record boundary.
  while IFS=$'\t' read -r -d '' SHA AN AE CN CE; do
    META_TOTAL=$((META_TOTAL+1))
    BAD=""
    case "$AE$CE" in *.local|*.local\ *) BAD="bonjour-hostname email" ;; esac
    [ -z "$BAD" ] && case "$AE" in *.local) BAD="bonjour-hostname email" ;; esac
    [ -z "$BAD" ] && case "$CE" in *.local) BAD="bonjour-hostname email" ;; esac
    if [ -z "$BAD" ]; then
      while IFS= read -r ID; do
        [ -z "$ID" ] && continue
        if printf '%s\n' "$AN" "$AE" "$CN" "$CE" | grep -qiF -- "$ID"; then
          BAD="machine-identity string"; break
        fi
      done < "$TMP/identity.txt"
    fi
    if [ -n "$BAD" ]; then
      META_HITS=$((META_HITS+1))
      # The offending value is NEVER echoed - reporting a leak by reproducing it is the leak.
      [ $META_HITS -le 12 ] && printf '           %.10s  %s in author/committer <redacted>\n' "$SHA" "$BAD"
    fi
  done < <(git log -z --format='%H%x09%an%x09%ae%x09%cn%x09%ce' $META_RANGE 2>/dev/null)
  # shellcheck disable=SC2086
  if [ "$META_TOTAL" = "0" ]; then
    echo "SKIPPED  no commits in scope ($META_RANGE)"
  elif [ "$META_HITS" = "0" ]; then
    echo "CLEAN    commit metadata: 0 of $META_TOTAL commit(s) carry a machine identity"
  else
    echo "BLOCKER  commit metadata: $META_HITS of $META_TOTAL commit(s) carry a machine identity"
    [ $META_HITS -gt 12 ] && echo "           ... and $((META_HITS-12)) more"
    echo "           Not fixable by editing a file: it is in the commit headers. Either rewrite"
    echo "           those commits, or accept it. scripts/build-publish-tree.sh now refuses to"
    echo "           MINT a new one (D-145)."
    FINDINGS=$((FINDINGS+1))
  fi
fi

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
