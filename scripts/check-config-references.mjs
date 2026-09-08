#!/usr/bin/env node
/**
 * CONFIG REFERENCE CHECK — does every repo object our configuration names actually exist?
 *
 * WHY THIS EXISTS
 *
 * `.github/dependabot.yml` named a label `dependencies`. That label did not exist on
 * `djayamah/usewarden`. GitHub's documented behaviour for that case is:
 *
 *     "If any of these labels is not defined in the repository, it is ignored."
 *     - docs.github.com/en/code-security/dependabot/working-with-dependabot/
 *       dependabot-options-reference, read 2026-09-08
 *
 * So Dependabot opened four pull requests over three weeks, every one of them unlabelled, and
 * nothing anywhere said why. The config was not wrong in a way any tool would report; it named
 * something that was not there, and the naming silently did nothing.
 *
 * That is the same defect class as a guard whose `allowed_paths` points at a directory nobody
 * uses: the control is present, is syntactically valid, reads as if it is working, and is
 * enforcing nothing. This repository already refuses to ship that shape of failure in its own
 * policy engine. It should not ship it in its own CI configuration either.
 *
 * WHAT IT CHECKS
 *
 *   labels        .github/dependabot.yml, .github/ISSUE_TEMPLATE/*.yml, .github/workflows/*.yml
 *   environments  .github/workflows/*.yml
 *   actors/teams  .github/CODEOWNERS, and `assignees:`/`reviewers:` in dependabot.yml
 *
 * plus one static check that needs no network: dependabot config keys GitHub has REMOVED.
 * `reviewers:` was retired on 2026-08-08 (github.blog/changelog/2025-08-08-dependabot-reviewers-
 * configuration-option-is-replaced-by-code-owners). A removed key is the same defect wearing a
 * different hat — config that names something that is not there any more.
 *
 * WHY THIS SCANS RATHER THAN PARSES, AND WHY IT DOES NOT USE src/policy/yaml.ts
 *
 * `src/policy/yaml.ts` is a security control (docs/THREAT-MODEL.md T-06). Its subset is narrow ON
 * PURPOSE — it rejects flow sequences and block scalars — because `usewarden.yaml` can arrive from
 * an untrusted clone. GitHub's own workflow files use both (`labels: ["bug"]`, `run: |`), so that
 * parser cannot read them, and widening it so it could would weaken the control that protects
 * against untrusted input in order to read four files we wrote ourselves. Wrong trade.
 *
 * So this is a targeted SCANNER, not a parser. It looks for the specific keys that name repo
 * objects and ignores everything else. A scanner that over-collects merely reports more; a parser
 * that chokes on one construct reports nothing and passes. Given the failure being prevented is
 * "a check that silently found nothing", the scanner is the safer shape — and `--self-test`
 * exists because a scanner that extracts zero references would otherwise report a clean run.
 *
 * EXIT CODES
 *   0  every reference resolves to something that exists
 *   1  a reference names something that does not exist, or a removed config key is in use
 *   3  UNVERIFIED — no `gh`, not authenticated, or the API was unreachable. Per CLAUDE.md §4.4
 *      this is NOT a pass: scripts/verify-all.sh counts it by name and drops "ALL GATES GREEN".
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Dependabot options GitHub has removed. Keeping the retirement date and the announcement in the
 * table means the next reader can check whether it is still true rather than trusting this file.
 */
const REMOVED_DEPENDABOT_KEYS = [
  {
    key: 'reviewers',
    retired: '2025-08-08',
    source: 'https://github.blog/changelog/2025-08-08-dependabot-reviewers-configuration-option-is-replaced-by-code-owners/',
    instead: 'use .github/CODEOWNERS — Dependabot honours it, and it applies to human PRs too',
  },
];

// ---------------------------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------------------------

/** A reference from a config file to something that must exist in the repository. */
/** @typedef {{ kind: 'label'|'environment'|'actor'|'team', name: string, file: string, line: number }} Ref */

/**
 * Strips the bodies of block scalars (`run: |`, `value: >`) so that prose inside a shell step
 * cannot be mistaken for configuration. Returns the surviving lines with their ORIGINAL line
 * numbers, because a finding that points at the wrong line is a finding nobody can act on.
 */
function significantLines(text) {
  const raw = text.split(/\r?\n/);
  /** @type {{ n: number, indent: number, text: string }[]} */
  const out = [];
  let skipBelow = null; // indent of the key that opened a block scalar
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    if (skipBelow !== null) {
      if (indent > skipBelow) continue;
      skipBelow = null;
    }
    if (/:\s*[|>][-+0-9]*\s*(#.*)?$/.test(line)) { skipBelow = indent; continue; }
    if (line.trimStart().startsWith('#')) continue;
    out.push({ n: i + 1, indent, text: line });
  }
  return out;
}

/** Splits a YAML flow sequence body — `"a", 'b', c` — into its items. */
function flowItems(body) {
  return body
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, '').trim())
    .filter((s) => s.length > 0);
}

/**
 * Reads the value of `key` wherever it appears, in either shape YAML allows:
 *   key: ["a", "b"]        (flow)
 *   key:                   (block)
 *     - a
 *     - b
 * Returns `{ items, keyLines }` — `keyLines` is every line the key itself appeared on, which is
 * what the removed-key check needs.
 */
function sequenceValues(lines, key) {
  const items = [];
  const keyLines = [];
  const re = new RegExp(`^(\\s*)${key}:\\s*(.*)$`);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].text.match(re);
    if (!m) continue;
    keyLines.push(lines[i].n);
    const indent = m[1].length;
    const inline = m[2].replace(/\s+#.*$/, '').trim();
    if (inline.startsWith('[')) {
      for (const v of flowItems(inline.replace(/^\[|\]$/g, ''))) items.push({ value: v, line: lines[i].n });
      continue;
    }
    if (inline !== '') { items.push({ value: inline.replace(/^["']|["']$/g, ''), line: lines[i].n }); continue; }
    for (let j = i + 1; j < lines.length && lines[j].indent > indent; j++) {
      const item = lines[j].text.trim().match(/^-\s*(.+)$/);
      if (!item) continue;
      items.push({ value: item[1].replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, ''), line: lines[j].n });
    }
  }
  return { items, keyLines };
}

/** `environment: name` and the expanded `environment:` / `name: x` form. */
function environmentNames(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].text.match(/^(\s*)environment:\s*(.*)$/);
    if (!m) continue;
    const indent = m[1].length;
    const inline = m[2].replace(/\s+#.*$/, '').trim();
    if (inline !== '' && !inline.startsWith('{')) {
      out.push({ value: inline.replace(/^["']|["']$/g, ''), line: lines[i].n });
      continue;
    }
    for (let j = i + 1; j < lines.length && lines[j].indent > indent; j++) {
      const nm = lines[j].text.trim().match(/^name:\s*(.+)$/);
      if (nm) { out.push({ value: nm[1].trim().replace(/^["']|["']$/g, ''), line: lines[j].n }); break; }
    }
  }
  return out;
}

/** `@user` and `@org/team` out of a CODEOWNERS file. */
function codeownersActors(text) {
  const out = [];
  const raw = text.split(/\r?\n/);
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i].replace(/#.*$/, '');
    for (const m of line.matchAll(/@([A-Za-z0-9][A-Za-z0-9-]*)(\/[A-Za-z0-9._-]+)?/g)) {
      out.push({ value: m[2] ? `${m[1]}${m[2]}` : m[1], line: i + 1, team: Boolean(m[2]) });
    }
  }
  return out;
}

/** Everything in the tree that names a repository object. */
function collectReferences() {
  /** @type {Ref[]} */
  const refs = [];
  const dynamic = [];

  const add = (kind, value, file, line) => {
    // `${{ vars.X }}` and friends are resolved by Actions at run time. Reporting them as missing
    // would be a lie; reporting them as fine would be a different lie. They are listed separately.
    if (value.includes('${{')) { dynamic.push({ kind, value, file, line }); return; }
    refs.push({ kind, name: value, file, line });
  };

  const yamlFiles = [
    '.github/dependabot.yml',
    ...listDir('.github/workflows').filter((f) => /\.ya?ml$/.test(f)),
    ...listDir('.github/ISSUE_TEMPLATE').filter((f) => /\.ya?ml$/.test(f)),
  ].filter((f) => fs.existsSync(path.join(REPO, f)));

  for (const file of yamlFiles) {
    const lines = significantLines(fs.readFileSync(path.join(REPO, file), 'utf8'));
    for (const it of sequenceValues(lines, 'labels').items) add('label', it.value, file, it.line);
    for (const it of sequenceValues(lines, 'assignees').items) add('actor', it.value.replace(/^@/, ''), file, it.line);
    for (const it of sequenceValues(lines, 'reviewers').items) add('actor', it.value.replace(/^@/, ''), file, it.line);
    for (const it of environmentNames(lines)) add('environment', it.value, file, it.line);
  }

  const owners = path.join(REPO, '.github/CODEOWNERS');
  if (fs.existsSync(owners)) {
    for (const a of codeownersActors(fs.readFileSync(owners, 'utf8'))) {
      add(a.team ? 'team' : 'actor', a.value, '.github/CODEOWNERS', a.line);
    }
  }

  return { refs, dynamic };
}

function listDir(rel) {
  const dir = path.join(REPO, rel);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((f) => `${rel}/${f}`);
}

/** Dependabot keys GitHub has removed, still present in the config. */
function removedKeysInUse() {
  const file = '.github/dependabot.yml';
  if (!fs.existsSync(path.join(REPO, file))) return [];
  const lines = significantLines(fs.readFileSync(path.join(REPO, file), 'utf8'));
  const found = [];
  for (const k of REMOVED_DEPENDABOT_KEYS) {
    for (const n of sequenceValues(lines, k.key).keyLines) found.push({ ...k, file, line: n });
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// What actually exists
// ---------------------------------------------------------------------------------------------

class Unverified extends Error {}

function gh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8' });
  if (r.error && r.error.code === 'ENOENT') throw new Unverified('the `gh` CLI is not installed');
  return r;
}

/** The repository these configs will actually run in — derived, never typed in twice. */
function targetRepo() {
  const flag = process.argv.find((a) => a.startsWith('--repo='));
  if (flag) return flag.slice('--repo='.length);
  const url = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).repository?.url ?? '';
  const m = url.match(/github\.com[/:]([^/]+\/[^/.]+)/);
  if (!m) throw new Unverified('package.json does not name a GitHub repository to check against');
  return m[1];
}

function apiJson(repoSlug, endpoint) {
  const r = gh(['api', `repos/${repoSlug}/${endpoint}`, '--paginate']);
  if (r.status !== 0) {
    const err = (r.stderr || '').trim();
    if (/HTTP 401|not logged|authentication|gh auth login/i.test(err)) throw new Unverified(`not authenticated to GitHub: ${err.split('\n')[0]}`);
    if (/dial tcp|no such host|network|timeout|connection refused/i.test(err)) throw new Unverified(`GitHub was unreachable: ${err.split('\n')[0]}`);
    if (/HTTP 404/.test(err)) return null;
    throw new Unverified(`gh api repos/${repoSlug}/${endpoint} failed: ${err.split('\n')[0]}`);
  }
  // --paginate concatenates JSON arrays; `gh` emits them back to back for array endpoints.
  try { return JSON.parse(r.stdout); } catch { return JSON.parse(`[${r.stdout.replace(/\]\s*\[/g, ',')}]`.replace(/^\[\[/, '[').replace(/\]\]$/, ']')); }
}

function inventory(repoSlug) {
  const labels = new Set((apiJson(repoSlug, 'labels') ?? []).map((l) => l.name));
  const envs = new Set(((apiJson(repoSlug, 'environments') ?? {}).environments ?? []).map((e) => e.name));
  const teams = new Set((apiJson(repoSlug, 'teams') ?? []).map((t) => `${t.organization?.login ?? ''}/${t.slug}`));
  if (labels.size === 0) throw new Unverified(`read zero labels from ${repoSlug} — the inventory is not trustworthy`);
  return { labels, envs, teams };
}

/**
 * A user must EXIST and be able to act on this repository. `users/{login}` alone is not enough:
 * a real GitHub account with no access to the repo cannot be assigned or requested, so CODEOWNERS
 * naming them silently assigns nobody — which is this whole defect class again.
 */
function actorHasAccess(repoSlug, login) {
  const r = gh(['api', `repos/${repoSlug}/collaborators/${login}`, '--silent']);
  if (r.status === 0) return true;
  const err = (r.stderr || '').trim();
  if (/HTTP 404|Not Found/i.test(err)) return false;
  if (/HTTP 403/.test(err)) throw new Unverified(`cannot read the collaborator list of ${repoSlug} (HTTP 403)`);
  throw new Unverified(`collaborator check for @${login} failed: ${err.split('\n')[0]}`);
}

// ---------------------------------------------------------------------------------------------
// Self-test: a scanner that finds nothing must not report clean
// ---------------------------------------------------------------------------------------------

function selfTest() {
  const cases = [
    ['flow sequence', 'labels: ["bug", \'chore\']', (l) => sequenceValues(l, 'labels').items.map((i) => i.value), ['bug', 'chore']],
    ['block sequence', 'labels:\n  - alpha\n  - "beta"', (l) => sequenceValues(l, 'labels').items.map((i) => i.value), ['alpha', 'beta']],
    ['inline scalar environment', 'jobs:\n  a:\n    environment: release', (l) => environmentNames(l).map((i) => i.value), ['release']],
    ['expanded environment', 'jobs:\n  a:\n    environment:\n      name: github-pages\n      url: x', (l) => environmentNames(l).map((i) => i.value), ['github-pages']],
    ['block scalar bodies are ignored', 'steps:\n  - run: |\n      labels:\n        - not-a-label\n  - name: x', (l) => sequenceValues(l, 'labels').items.map((i) => i.value), []],
    ['trailing comments are stripped', 'labels:\n  - real   # not-a-label', (l) => sequenceValues(l, 'labels').items.map((i) => i.value), ['real']],
  ];
  let bad = 0;
  for (const [name, src, run, expected] of cases) {
    const got = run(significantLines(src));
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`}`);
    if (!ok) bad++;
  }
  const owners = codeownersActors('* @alice\n/src/ @org/team-a  # comment @ignored-in-comment\n');
  const ownersOk = JSON.stringify(owners.map((o) => o.value)) === JSON.stringify(['alice', 'org/team-a']);
  console.log(`  ${ownersOk ? 'ok  ' : 'FAIL'}  CODEOWNERS actors and teams${ownersOk ? '' : ` — got ${JSON.stringify(owners.map((o) => o.value))}`}`);
  if (!ownersOk) bad++;
  return bad;
}

// ---------------------------------------------------------------------------------------------

function main() {
  const selfTestOnly = process.argv.includes('--self-test-only');
  // `--list` prints what the scanner SEES, with no network. It exists so a test can assert the
  // scanner is not blind against the real .github/ files on a machine with no GitHub access -
  // the self-test proves the extractors work on synthetic input, and this proves they fire on
  // ours. Both matter: the failure being guarded against is a check that quietly finds nothing.
  if (process.argv.includes('--list')) {
    const { refs, dynamic } = collectReferences();
    console.log(JSON.stringify({ refs, dynamic, removedKeys: removedKeysInUse() }, null, 2));
    return 0;
  }
  console.log('=== config reference check ===');
  console.log('  scanner self-test (a scanner that extracts nothing would otherwise report clean):');
  const selfTestFailures = selfTest();
  if (selfTestFailures > 0) {
    console.error(`\nFAIL  the scanner's own self-test failed ${selfTestFailures} case(s). Its verdict below means nothing.`);
    return 1;
  }
  if (selfTestOnly) return 0;

  const { refs, dynamic } = collectReferences();
  const removed = removedKeysInUse();

  console.log(`\n  scanned ${new Set(refs.map((r) => r.file)).size} file(s), found ${refs.length} reference(s)`);
  if (refs.length === 0) {
    console.error('\nFAIL  the scanner found no references at all. Either .github/ is empty or the scanner is blind.');
    return 1;
  }

  const problems = [];

  for (const r of removed) {
    problems.push(`${r.file}:${r.line}  \`${r.key}:\` was REMOVED from dependabot.yml on ${r.retired} and now does nothing\n`
      + `      instead: ${r.instead}\n`
      + `      source:  ${r.source}`);
  }

  let repoSlug, inv;
  try {
    repoSlug = targetRepo();
    inv = inventory(repoSlug);
  } catch (e) {
    if (e instanceof Unverified) {
      console.log(`\nUNVERIFIED  ${e.message}`);
      console.log('            The static checks above ran; existence of labels, environments and');
      console.log('            actors was NOT checked. This is not a pass (CLAUDE.md §4.4).');
      if (problems.length > 0) { console.error('\n' + problems.map((p) => `FAIL  ${p}`).join('\n')); return 1; }
      return 3;
    }
    throw e;
  }

  console.log(`  checked against ${repoSlug}: ${inv.labels.size} labels, ${inv.envs.size} environments`);

  const seenActors = new Map();
  for (const r of refs) {
    if (r.kind === 'label' && !inv.labels.has(r.name)) {
      problems.push(`${r.file}:${r.line}  label \`${r.name}\` does not exist in ${repoSlug} — GitHub ignores it silently`);
    }
    if (r.kind === 'environment' && !inv.envs.has(r.name)) {
      problems.push(`${r.file}:${r.line}  environment \`${r.name}\` does not exist in ${repoSlug} — the job's protection rules are not what this file says`);
    }
    if (r.kind === 'team' && inv.teams.size > 0 && !inv.teams.has(r.name)) {
      problems.push(`${r.file}:${r.line}  team \`@${r.name}\` has no access to ${repoSlug} — it will be assigned nothing`);
    }
    if (r.kind === 'team' && inv.teams.size === 0) {
      problems.push(`${r.file}:${r.line}  team \`@${r.name}\` is named, but ${repoSlug} has no teams at all — it will be assigned nothing`);
    }
    if (r.kind === 'actor') {
      if (!seenActors.has(r.name)) seenActors.set(r.name, actorHasAccess(repoSlug, r.name));
      if (!seenActors.get(r.name)) {
        problems.push(`${r.file}:${r.line}  @${r.name} is not a collaborator on ${repoSlug} — naming them assigns nobody`);
      }
    }
  }

  for (const d of dynamic) {
    console.log(`  not checked (resolved at run time): ${d.file}:${d.line} ${d.kind} ${d.value}`);
  }

  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):\n`);
    for (const p of problems) console.error(`FAIL  ${p}`);
    console.error('\nA configuration that names something absent is not a configuration that is off.');
    console.error('It is one that reads as on and enforces nothing.');
    return 1;
  }

  console.log('\nPASS  every label, environment, actor and team named in .github/ exists in ' + repoSlug);
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  if (e instanceof Unverified) { console.log(`UNVERIFIED  ${e.message}`); process.exit(3); }
  throw e;
}
