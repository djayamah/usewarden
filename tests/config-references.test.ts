import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'check-config-references.mjs');

/**
 * The defect this guards against, in one sentence: `.github/dependabot.yml` named a label that
 * did not exist, GitHub ignored it silently, and four pull requests sat unlabelled for three
 * weeks with nothing anywhere saying why.
 *
 * These tests are all OFFLINE. The existence half of the check needs GitHub and is a network gate
 * in scripts/verify-all.sh and a step in CI; what is asserted here is the half that can be
 * asserted without a network, which is the half that decides whether the other half means
 * anything: does the scanner actually SEE our configuration files, and is it wired in.
 */
function run(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: REPO });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

interface Ref { kind: string; name: string; file: string; line: number }
interface Listing { refs: Ref[]; dynamic: unknown[]; removedKeys: { key: string }[] }

describe('config references: every repo object our config names must exist', () => {
  test('the scanner passes its own self-test', () => {
    const r = run(['--self-test-only']);
    assert.equal(r.status, 0, `the extractors are broken, so the checker's verdict is worthless:\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /ok {4}block scalar bodies are ignored/);
  });

  /**
   * THE SETUP ASSERTION (CLAUDE.md §4.2). Everything below is only meaningful if the scanner
   * really reads our files. A scanner that extracts nothing reports a clean run, which is the
   * exact shape of failure this whole check exists to prevent - so it is asserted first, against
   * the real `.github/` tree, and by name rather than by count.
   */
  const listing = (): Listing => {
    const r = run(['--list']);
    assert.equal(r.status, 0, `--list failed:\n${r.stderr}`);
    return JSON.parse(r.stdout) as Listing;
  };

  test('THE SCANNER IS NOT BLIND: it finds the references that are really in .github/', () => {
    const { refs } = listing();
    const named = (kind: string) => refs.filter((r) => r.kind === kind).map((r) => r.name);

    assert.ok(refs.length > 0, 'the scanner found nothing at all in .github/ - it is blind');
    assert.ok(named('label').includes('dependencies'),
      'dependabot.yml names the `dependencies` label and the scanner must see it - that is the defect this check was written for');
    assert.ok(named('label').includes('bug'),
      'the bug_report issue template names `bug` in a FLOW sequence - the block-sequence path alone is not enough');
    assert.ok(named('environment').includes('release'),
      'release.yml runs in the `release` environment, which is the gate on staging a package');
    assert.ok(named('environment').includes('github-pages'),
      'pages.yml uses the expanded `environment:`/`name:` form, which needs its own extractor path');
    assert.ok(named('actor').includes('djayamah'), 'CODEOWNERS assigns the maintainer and the scanner must see it');
  });

  test('every file that can name a repo object is actually scanned', () => {
    const { refs } = listing();
    const scanned = new Set(refs.map((r) => r.file));
    for (const f of ['.github/dependabot.yml', '.github/CODEOWNERS']) {
      assert.ok(scanned.has(f), `${f} names repo objects but the scanner produced no reference from it`);
    }
    // Every issue-form template declaring `labels:` must appear. Adding a template with a new
    // label is exactly when this check earns its keep, so it must not be possible to add one the
    // scanner ignores.
    const dir = path.join(REPO, '.github', 'ISSUE_TEMPLATE');
    for (const f of fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
      const rel = `.github/ISSUE_TEMPLATE/${f}`;
      if (!/^labels:/m.test(fs.readFileSync(path.join(dir, f), 'utf8'))) continue;
      assert.ok(scanned.has(rel), `${rel} declares labels: and the scanner produced no reference from it`);
    }
  });

  test('no dependabot option GitHub has removed is in use', () => {
    // `reviewers:` was retired 2025-08-08 in favour of code owners. It sat in this repository for
    // a year afterwards doing nothing, which is only invisible because CODEOWNERS was requesting
    // the same person anyway.
    assert.deepEqual(listing().removedKeys, [],
      'a removed dependabot option is config that names something no longer there');
  });

  test('the CODEOWNERS entry that makes `reviewers:` unnecessary really is there', () => {
    // Removing `reviewers:` is only safe because CODEOWNERS covers every path. If someone
    // narrows CODEOWNERS later, this fails rather than silently leaving Dependabot PRs
    // with no reviewer at all.
    const owners = fs.readFileSync(path.join(REPO, '.github', 'CODEOWNERS'), 'utf8');
    assert.match(owners, /^\*\s+@\S+/m,
      'CODEOWNERS must assign a catch-all owner, because dependabot.yml no longer names reviewers');
  });

  test("CI's invocation survives `bash -e`, which swallowed the exit-3 branch once already", () => {
    // The first public CI run went red on an UNVERIFIED the step was written to tolerate.
    // Actions runs `bash -e`; `node script; rc=$?` never reaches the assignment, because `-e`
    // kills the step on the non-zero exit itself. A command inside an `if` condition is the one
    // place `-e` does not fire, so the form matters and is asserted rather than remembered.
    const ci = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
    const step = ci.slice(ci.indexOf('Config references'));
    assert.match(step, /if node scripts\/check-config-references\.mjs; then rc=0; else rc=\$\?; fi/,
      'the exit code must be captured inside an `if` condition, or `bash -e` ends the step first');
    assert.doesNotMatch(step.split('\n').slice(0, 20).join('\n'), /^\s*node scripts\/check-config-references\.mjs; rc=\$\?/m,
      'the bare `cmd; rc=$?` form is the bug: under `-e` the assignment is unreachable');
  });

  test('the check covers EVERY repository these configs run in, not just the published one', () => {
    // It read `package.json`'s repository.url and checked that one — the public repo. The same
    // .github/ tree is on the private mirror, Dependabot runs there too, and it had been posting
    // "the following labels could not be found" on that repository since 2026-08-19 as well. The
    // checker had the defect it exists to catch (D-276). The set is scripts/repos.txt now, the
    // same list scripts/repo-health.mjs reads, so a repository is in scope for both or neither.
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assert.match(src, /repos\.txt/, 'the repository set must come from scripts/repos.txt');
    assert.ok(!/repository\?\.url/.test(src),
      'reading the single repository out of package.json is what limited it to one surface');
    const declared = fs.readFileSync(path.join(REPO, 'scripts', 'repos.txt'), 'utf8')
      .split('\n').map((l) => l.replace(/#.*/, '').trim()).filter((l) => l !== '');
    assert.ok(declared.length >= 2, 'setup failed: fewer than two repositories, so this cannot be tested');
  });

  test('the check is wired into CI and into verify-all, not merely present', () => {
    // A gate nobody runs is a gate that does not exist. Six of this project's real defects were
    // found only because something actually invoked the check.
    const ci = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
    assert.match(ci, /check-config-references\.mjs/, 'CI must run the config reference check');
    const verifyAll = fs.readFileSync(path.join(REPO, 'scripts', 'verify-all.sh'), 'utf8');
    assert.match(verifyAll, /check-config-references\.mjs/, 'verify-all.sh must run the config reference check');
  });

  test('@types/node is held at the major that matches engines.node', () => {
    // Not a style rule. On @types/node 22 the typechecker refuses `new URLPattern(...)`, which
    // does not exist on Node 22; on 26 it accepts it and the failure moves to run time for a user
    // on Active LTS. Measured 2026-09-08, verification/run-2026-09-08/13-types-ahead-of-engines-demo.txt.
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as
      { engines?: Record<string, string>; devDependencies?: Record<string, string> };
    const floor = (pkg.engines?.node ?? '').match(/(\d+)/)?.[1];
    const types = (pkg.devDependencies?.['@types/node'] ?? '').match(/(\d+)/)?.[1];
    assert.ok(floor && types, 'both engines.node and @types/node must name a major version');
    assert.equal(types, floor,
      `@types/node is ^${types} while engines.node allows ${floor} - the typechecker is now describing a runtime our users do not have`);

    const dependabot = fs.readFileSync(path.join(REPO, '.github', 'dependabot.yml'), 'utf8');
    assert.match(dependabot, /dependency-name:\s*"@types\/node"/,
      'the constraint must be enforced in dependabot.yml, or the next major bump reopens the same PR');
    assert.match(dependabot, /version-update:semver-major/,
      'only the MAJOR bump is held - minor and patch updates inside the line must still come through');
  });
});
