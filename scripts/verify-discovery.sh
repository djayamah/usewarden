#!/usr/bin/env bash
# VERIFY THAT THE PUBLIC REPOSITORY'S DISCOVERY SETTINGS MATCH WHAT WE DOCUMENT.
#
# ---------------------------------------------------------------------------------------------
# WHY THIS EXISTS
# ---------------------------------------------------------------------------------------------
# `launch/DISCOVERABILITY.md` names an exact set of GitHub topics and npm keywords, chosen as
# search queries and argued for one group at a time. Nothing checked that the live repository
# still carried them. That is the shape that has now produced four separate defects here:
#
#   D-140/D-142  a control aimed at what we are about to ship, with nothing aimed at what we
#                already shipped
#   D-152        the Node pin fixed in the repository where the release does not run
#   D-171        the `firewall` wording fixed on private main while the PUBLISHED package
#                carried it
#   (this run)   `docs/METRICS.md` fixed privately while the production bot reads the public copy
#
# Every one is a document and a live surface disagreeing, with nobody looking. Topics and keywords
# are unusually prone to it: they are edited in a web UI, they are invisible in a diff, and being
# wrong costs nothing today and everything at launch.
#
# READ-ONLY. This script changes nothing; it reports. Fixing drift is a deliberate act.
#
#     ./scripts/verify-discovery.sh          # compare, print a table, exit non-zero on drift
#
# Requires `gh`, authenticated. With no network it reports UNVERIFIED and exits non-zero, because
# CLAUDE.md §4.4 is explicit that a control whose state could not be checked is a failure and not
# a pass: "I could not tell" and "it is fine" are different sentences.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT" || exit 2

REPO="${DISCOVERY_REPO:-djayamah/usewarden}"

if ! command -v gh >/dev/null 2>&1; then
  echo "UNVERIFIED: gh is not installed, so the live settings could not be read." >&2
  exit 3
fi

python3 - "$REPO" <<'PY'
import json, re, subprocess, sys

repo = sys.argv[1]
fail = 0
unverified = 0

def gh_json(args):
    p = subprocess.run(['gh', 'api', *args], capture_output=True, text=True)
    if p.returncode != 0:
        return None, p.stderr.strip()
    try:
        return json.loads(p.stdout), None
    except json.JSONDecodeError as e:
        return None, str(e)

def section(doc, heading):
    """The fenced block under a `### heading` in DISCOVERABILITY.md."""
    m = re.search(r'### ' + re.escape(heading) + r'.*?```\n(.*?)```', doc, re.S)
    if not m:
        return None
    return [t.strip() for t in re.split(r'[,\n]', m.group(1)) if t.strip()]

doc = open('launch/DISCOVERABILITY.md').read()

def compare(label, documented, actual):
    global fail
    if documented is None:
        print(f'UNVERIFIED  {label}: could not find the documented list in DISCOVERABILITY.md')
        return 1
    missing = sorted(set(documented) - set(actual))
    extra = sorted(set(actual) - set(documented))
    if not missing and not extra:
        print(f'PASS        {label}: {len(actual)} entries, exactly as documented')
        return 0
    print(f'FAIL        {label}:')
    if missing:
        print(f'              documented but MISSING from the live surface: {", ".join(missing)}')
    if extra:
        print(f'              on the live surface but NOT documented:       {", ".join(extra)}')
    fail = 1
    return 0

print(f'Discovery settings for {repo}, against launch/DISCOVERABILITY.md')
print()

# --- GitHub topics -----------------------------------------------------------------------------
meta, err = gh_json([f'repos/{repo}'])
if meta is None:
    print(f'UNVERIFIED  github topics: could not read the repository ({err})')
    unverified += 1
else:
    unverified += compare('github topics', section(doc, 'GitHub topics'), meta.get('topics', []))

    # --- description: the sentence npmjs.com and github.com both print under the name ----------
    desc = meta.get('description') or ''
    if not desc.strip():
        print('FAIL        description: empty')
        fail = 1
    elif re.search(r'\bfirewall\b', desc, re.I):
        # D-095 rejected "a firewall for your AI coding agents" as an overclaim, and D-171 found it
        # shipped anyway in two surfaces nobody was checking. This is the third surface.
        print('FAIL        description: contains the rejected "firewall" claim (D-095, D-171)')
        fail = 1
    else:
        print(f'PASS        description: set, {len(desc)} chars, no rejected claim')

# --- npm keywords, in all THREE places they can disagree ---------------------------------------
#
# The first version of this script compared the documented list against the LOCAL package.json and
# reported PASS. That is the copy we review; it is not the copy we ship. `release.yml` runs in the
# PUBLIC repository from the PUBLIC checkout, so the public package.json is what npm indexes — and
# it still carried the eight keywords from before the discoverability work, which is what
# `usewarden@0.0.0` is serving on the registry right now.
#
# So a control written specifically to catch document-versus-live drift had the exact defect it was
# written to catch, and passed. That is D-171 ("a guard aimed at the copy we review and not at the
# copy we ship is a guard that passes while the claim goes out") for the second time, in the guard
# added because of D-171. Three sources, three questions — the same shape as the three scans:
#
#   local package.json      what we are about to ship from here      informational
#   public/main             what the release will actually build     FAIL on drift
#   the registry            what the world can see today             FAIL on drift, once 0.1.0 is latest
documented_kw = section(doc, 'npm keywords (`package.json`)')

local_pkg = json.load(open('package.json'))
compare('npm keywords (local, reviewed)', documented_kw, local_pkg.get('keywords', []))

p = subprocess.run(['git', 'show', 'public/main:package.json'], capture_output=True, text=True)
if p.returncode != 0:
    print('UNVERIFIED  npm keywords (public tree): could not read public/main:package.json - '
          'run `git fetch public main`')
    unverified += 1
else:
    pub = json.loads(p.stdout)
    unverified += compare('npm keywords (PUBLIC tree - what ships)', documented_kw,
                          pub.get('keywords', []))
    if pub.get('scripts', {}).get('build', '') and 'chmod' not in pub['scripts']['build'].lower():
        # D-012's defect, in the tree the release builds from. `tsc` writes 0644 and a global
        # install runs the bin entry directly.
        print('FAIL        public build script does not set the execute bit on the bin entry '
              '(D-012); a global install would fail with EACCES')
        fail = 1
    else:
        print('PASS        public build script sets the execute bit on the bin entry')

p = subprocess.run(['npm', 'view', 'usewarden', 'keywords', '--json'], capture_output=True, text=True)
if p.returncode != 0 or not p.stdout.strip():
    print('UNVERIFIED  npm keywords (registry): could not read the registry')
    unverified += 1
else:
    try:
        reg = json.loads(p.stdout)
        ver = subprocess.run(['npm', 'view', 'usewarden', 'version'],
                             capture_output=True, text=True).stdout.strip()
        # Before 0.1.0 is `latest` the registry is serving a placeholder, so drift there is
        # expected and is reported as INFO. An alarm that is expected to be red is an alarm
        # nobody reads (D-142).
        if ver.startswith('0.0.'):
            missing = sorted(set(documented_kw or []) - set(reg))
            print(f'INFO        npm keywords (registry): serving {ver}, a placeholder - '
                  f'{len(missing)} documented keyword(s) absent. Re-check once 0.1.0 is latest')
        else:
            unverified += compare('npm keywords (REGISTRY - what shipped)', documented_kw, reg)
    except json.JSONDecodeError:
        print('UNVERIFIED  npm keywords (registry): unparseable response')
        unverified += 1

# --- surfaces that are gaps rather than drift ---------------------------------------------------
# Reported as INFO, not FAIL: they are unset by decision or blocked on a founder-only action, and
# a check that cries wolf every run is one nobody reads (D-142).
q = ('{repository(owner:"%s",name:"%s"){usesCustomOpenGraphImage releases{totalCount}}}'
     % tuple(repo.split('/')))
p = subprocess.run(['gh', 'api', 'graphql', '-f', f'query={q}'], capture_output=True, text=True)
if p.returncode != 0:
    print('UNVERIFIED  social preview / releases: GraphQL query failed')
    unverified += 1
else:
    d = json.loads(p.stdout)['data']['repository']
    print(f'INFO        social preview image: '
          f'{"custom" if d["usesCustomOpenGraphImage"] else "NOT SET - GitHub default card"}'
          f'  (no API exists; web UI only)')
    print(f'INFO        releases published: {d["releases"]["totalCount"]}')

print()
if fail:
    print('DRIFT: the live repository and launch/DISCOVERABILITY.md disagree. Fix one of them.')
    sys.exit(1)
if unverified:
    print(f'UNVERIFIED x{unverified}: a control whose state could not be checked is not a pass.')
    sys.exit(3)
print('All documented discovery settings match the live repository.')
PY
