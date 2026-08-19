#!/usr/bin/env bash
# PRE-PUBLISH CHECK (spec Phase 10).
#
# Fails loudly on anything wrong, and NEVER reports success for something it could not check.
# The final step deliberately does not decide for you: it prints the complete tarball file list
# for human inspection, because provenance proves which commit was built, not that the commit
# was authorised (ChainDrop, 2026-08-04).
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$REPO"
FAILED=0
TMPDIR_PPC="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_PPC"' EXIT
TMPJSON="$TMPDIR_PPC/pack.json"
LISTER="$TMPDIR_PPC/list.py"
SUSPECTER="$TMPDIR_PPC/suspect.py"

cat > "$LISTER" <<'PY'
import json, sys
p = json.load(open(sys.argv[1]))[0]
print(f"  name:     {p['name']}@{p['version']}")
print(f"  files:    {p['entryCount']}")
print(f"  unpacked: {p['unpackedSize']} bytes")
print()
for f in sorted(p['files'], key=lambda x: x['path']):
    print(f"    {f['size']:>9}  {f['path']}")
PY

cat > "$SUSPECTER" <<'PY'
import json, re, sys
p = json.load(open(sys.argv[1]))[0]
pat = re.compile(r'(^|/)(\.env|\.npmrc|\.git/|node_modules/|\.usewarden)|^(src|tests|fixtures|verification|scripts)/')
print('\n'.join(f['path'] for f in p['files'] if pat.search(f['path'])))
PY

say()  { printf '%-6s %s\n' "$1" "$2"; }
fail() { say FAIL "$1"; FAILED=1; }
pass() { say PASS "$1"; }

echo "=== PRE-PUBLISH CHECK ==="
echo "repo:   $REPO"
echo "commit: $(git rev-parse HEAD 2>/dev/null || echo '(not a git repo)')"
echo

# --- 1. no install scripts, in the manifest -------------------------------
echo "--- 1. lifecycle scripts (the ChainDrop mechanism) ---"
FOUND="$(python3 - <<'PY'
import json
p=json.load(open('package.json'))
bad=[k for k in ('preinstall','install','postinstall','prepare','prepublish')
     if k in (p.get('scripts') or {})]
print(','.join(bad))
PY
)"
if [ -n "$FOUND" ]; then fail "package.json declares: $FOUND"; else pass "package.json declares no preinstall/install/postinstall/prepare/prepublish"; fi

# --- 2. no install scripts anywhere in the lockfile -----------------------
echo
echo "--- 2. lockfile ---"
if [ ! -f package-lock.json ]; then
  fail "package-lock.json is MISSING - it must be committed"
else
  pass "package-lock.json present"
  if git ls-files --error-unmatch package-lock.json >/dev/null 2>&1; then
    pass "package-lock.json is tracked by git"
  else
    fail "package-lock.json is NOT tracked by git"
  fi
  if [ -n "$(git status --porcelain package-lock.json 2>/dev/null)" ]; then
    fail "package-lock.json has uncommitted changes"
  else
    pass "package-lock.json is clean (no uncommitted changes)"
  fi
  OFFENDERS="$(python3 - <<'PY'
import json
lock=json.load(open('package-lock.json'))
bad=[]
for name,e in (lock.get('packages') or {}).items():
    if e.get('hasInstallScript'): bad.append(f"{name or '<root>'}: hasInstallScript")
    for k in ('preinstall','install','postinstall','prepare','prepublish'):
        if (e.get('scripts') or {}).get(k): bad.append(f"{name or '<root>'}: {k}")
print('\n'.join(bad))
PY
)"
  if [ -n "$OFFENDERS" ]; then
    fail "lockfile entries with install scripts:"; printf '%s\n' "$OFFENDERS" | sed 's/^/         /'
  else
    pass "no lockfile entry runs code on install"
  fi
  UNPINNED="$(python3 - <<'PY'
import json
lock=json.load(open('package-lock.json'))
bad=[n for n,e in (lock.get('packages') or {}).items() if n and not e.get('link') and not e.get('integrity')]
print('\n'.join(bad))
PY
)"
  if [ -n "$UNPINNED" ]; then fail "lockfile entries without an integrity hash:"; printf '%s\n' "$UNPINNED" | sed 's/^/         /'
  else pass "every lockfile entry is pinned to an integrity hash"; fi
fi

# --- 3. working tree ------------------------------------------------------
echo
echo "--- 3. working tree ---"
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  fail "working tree is dirty - publish from a clean tree so the provenance commit means something"
  git status --short | sed 's/^/         /'
else
  pass "working tree is clean"
fi

# --- 4. build is current --------------------------------------------------
echo
echo "--- 4. build ---"
if npm run --silent build >/dev/null 2>&1; then pass "npm run build succeeds"; else fail "npm run build FAILED"; fi
BIN="$(python3 -c "import json;print((json.load(open('package.json')).get('bin') or {}).get('usewarden',''))")"
if [ -n "$BIN" ] && [ -f "$BIN" ]; then pass "bin target exists: $BIN"; else fail "bin target missing: ${BIN:-<none>}"; fi

# --- 5. tests -------------------------------------------------------------
echo
echo "--- 5. tests ---"
if npm test >/dev/null 2>&1; then pass "full test suite green"; else fail "TEST SUITE FAILED"; fi

# --- 6. the human step ----------------------------------------------------
echo
echo "--- 6. npm pack --dry-run: THE FULL FILE LIST, FOR HUMAN INSPECTION ---"
echo "Provenance proves WHICH COMMIT was built. It does not prove the commit was AUTHORISED."
echo "ChainDrop's poisoned packages carried valid SLSA provenance. Read every line below."
echo
PACK_OUT="$(npm pack --dry-run --json 2>/dev/null)"
if [ -z "$PACK_OUT" ]; then
  fail "npm pack --dry-run produced no output - COULD NOT VERIFY the tarball contents"
else
  printf '%s' "$PACK_OUT" > "$TMPJSON"
  if ! python3 "$LISTER" "$TMPJSON"; then
    fail "could not parse npm pack --dry-run output - COULD NOT VERIFY the tarball contents"
  fi
  echo
  SUSPECT="$(python3 "$SUSPECTER" "$TMPJSON" 2>/dev/null)"
  if [ $? -ne 0 ]; then
    fail "could not scan the tarball file list - COULD NOT VERIFY"
  elif [ -n "$SUSPECT" ]; then
    fail "files that must NOT be published are in the tarball:"; printf '%s\n' "$SUSPECT" | sed 's/^/         /'
  else
    pass "no source, tests, fixtures, verification artifacts, .env or .npmrc in the tarball"
  fi
fi

echo
echo "--- 7. what this script CANNOT check ---"
echo "  These are human steps. Absence of a FAIL above does not cover them:"
echo "    * that every file in the list above is one you expect"
echo "    * that the version bump and CHANGELOG are correct"
echo "    * that the commit being published is one you reviewed"
echo "  See launch/PUBLISH-CHECKLIST.md."
echo
if [ $FAILED -eq 0 ]; then
  echo "=== AUTOMATED CHECKS PASSED - the human inspection above is still required ==="
else
  echo "=== PRE-PUBLISH CHECK FAILED - DO NOT PUBLISH ==="
fi
exit $FAILED
