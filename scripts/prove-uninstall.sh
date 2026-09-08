#!/usr/bin/env bash
# Prove `usewarden uninstall` actually removed itself, by READING THE FILES (CLAUDE.md §4.1).
#
# WHY THIS EXISTS SEPARATELY FROM verification/dogfood/05-restore-proof.txt.
# That rehearsal restored from a backup taken AFTER usewarden had already created two of the
# three config files, so the comparison could not possibly surface the creation. It checked
# `~/.claude/settings.json` at step 5 and printed "BYTE-IDENTICAL RESTORE: PROVEN" on the
# strength of one file out of three. This script compares against INIT'S OWN FIRST backup —
# the only one that records the true pre-install state — and reports each file separately.
#
# It prints hashes, byte counts and KEY NAMES only. Never a value: `verification/` is published
# and an agent config can hold anything (CLAUDE.md §2, redact by construction).
#
# Usage: ./scripts/prove-uninstall.sh [BACKUP_DIR]   (default: init's earliest backup)
set -uo pipefail

BACKUPS="$HOME/.usewarden/backups"
BDIR="${1:-$(ls -1d "$BACKUPS"/*/ 2>/dev/null | sort | head -1)}"
BDIR="${BDIR%/}"
MAN="$BDIR/manifest.json"

echo "=== USEWARDEN UNINSTALL PROOF — read from the files, not from an exit code ==="
echo "date            $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "pre-init backup ${BDIR/#$HOME/~}"
echo

[ -r "$MAN" ] || { echo "FAIL: no manifest at $MAN"; exit 1; }

registered=0; residue=0; differs=0; total=0
# Iterate the manifest: it is the record of what init actually touched.
while IFS=$'\t' read -r target backup existed sha; do
  [ -n "$target" ] || continue
  total=$((total+1))
  echo "---- ${target/#$HOME/~}"

  if [ "$existed" = "true" ]; then
    echo "  pre-install : EXISTED  sha256=$sha"
  else
    echo "  pre-install : DID NOT EXIST  (manifest: existed=false, backup=null)"
  fi

  if [ ! -e "$target" ]; then
    echo "  now         : ABSENT"
    if [ "$existed" = "true" ]; then
      echo "  VERDICT     : FAIL — file existed before install and is now gone"; residue=$((residue+1))
    else
      echo "  VERDICT     : PASS — absent before, absent now (byte-identical: nothing)"
    fi
    echo; continue
  fi

  now_sha=$(shasum -a 256 "$target" | cut -d' ' -f1)
  echo "  now         : EXISTS   sha256=$now_sha  bytes=$(wc -c < "$target" | tr -d ' ')"

  # The security question, asked separately from the tidiness question.
  refs=$(grep -ic 'warden' "$target" 2>/dev/null | tr -d '[:space:]'); refs="${refs:-0}"
  hookkey=$(node -e 'try{const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(Object.prototype.hasOwnProperty.call(v,"hooks")?"PRESENT":"absent")}catch(e){console.log("UNPARSEABLE")}' "$target")
  echo "  usewarden refs remaining : $refs"
  echo "  \"hooks\" container        : $hookkey"
  if [ "$refs" != "0" ] || [ "$hookkey" = "PRESENT" ]; then
    echo "  VERDICT     : FAIL (STILL REGISTERED) — usewarden can still fire from this file"
    registered=$((registered+1)); echo; continue
  fi

  if [ "$existed" != "true" ]; then
    echo "  VERDICT     : FAIL (residue) — usewarden CREATED this file; byte-identical to"
    echo "                pre-install means ABSENT, and it is still here. No hooks remain,"
    echo "                so nothing can fire; the file itself is litter."
    residue=$((residue+1)); echo; continue
  fi

  if [ "$now_sha" = "$sha" ]; then
    echo "  VERDICT     : PASS — byte-identical to pre-install"
  else
    # Not identical is not automatically usewarden's fault. Say WHICH keys moved.
    added=$(node -e '
      const fs=require("fs");
      const a=JSON.parse(fs.readFileSync(process.argv[1],"utf8")), b=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
      const A=new Set(Object.keys(a)), B=new Set(Object.keys(b));
      const add=[...B].filter(k=>!A.has(k)), rm=[...A].filter(k=>!B.has(k));
      const chg=[...B].filter(k=>A.has(k)&&JSON.stringify(a[k])!==JSON.stringify(b[k]));
      console.log(JSON.stringify({add,rm,chg}));' "$BDIR/$backup" "$target")
    echo "  differs; key-level delta (names only, no values): $added"
    echo "  VERDICT     : DIFFERS — see delta above. Judge by whether any key is usewarden's."
    differs=$((differs+1))
  fi
  echo
done < <(node -e '
  const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
  for(const [k,v] of Object.entries(m)) console.log([k,v.backup??"",String(v.existed),v.sha256??""].join("\t"));
' "$MAN")

# TWO SEPARATE QUESTIONS, REPORTED SEPARATELY. "Can it still fire?" is the security
# question and it is the one that decides whether the founder is unprotected. "Is the
# machine as it was?" is the tidiness question. Collapsing them into one pass/fail is how
# a clean uninstall gets reported as broken, or a littered one as clean.
echo "=== SUMMARY ==="
echo "  1. CAN USEWARDEN STILL FIRE?"
if [ "$registered" = "0" ]; then
  echo "     NO — zero hook registrations remain in any file init touched."
else
  echo "     YES — $registered file(s) still carry usewarden entries. NOT UNINSTALLED."
fi
echo "  2. IS THE MACHINE AS IT WAS BEFORE INSTALL?"
echo "     files byte-identical to pre-install : $((total-residue-differs)) of $total"
echo "     files left behind that init created : $residue"
echo "     files differing for other reasons   : $differs  (delta printed above; judge by key names)"
[ "$registered" = "0" ] || exit 1
