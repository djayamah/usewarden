import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'repo-health.mjs');
const LIST = path.join(REPO, 'scripts', 'repos.txt');

/**
 * D-273. A run fixed a defect on the public repository, swept the public repository, found it
 * green, and reported "all CI green" — while the PRIVATE mirror, where every one of those commits
 * landed first, had four failed workflow runs and a `pages` workflow that had never once
 * succeeded in its life.
 *
 * The report was true and it was about the wrong surface. That is the same defect as a guard whose
 * `allowed_paths` names a directory nobody uses, and as a config naming a label that does not
 * exist: the control is real, its answer is correct, and it is answering about somewhere the
 * problem is not.
 *
 * These tests are OFFLINE. The health verdict itself needs GitHub and runs as a netgate in
 * scripts/verify-all.sh. What is asserted here is the half that decides whether that verdict means
 * anything: that the script knows how many repositories exist, and that it cannot be talked into
 * reporting green about fewer.
 */
function run(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: REPO });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const declared = (): string[] =>
  fs.readFileSync(LIST, 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter((l) => l !== '');

describe('repo health: the sweep covers every repository, or it is not a sweep', () => {
  test('THE SETUP LANDS: this project really does push to more than one repository', () => {
    // Everything below is only interesting because there is more than one. If this ever drops to
    // one, the tests beneath are vacuous and should be read again rather than trusted.
    assert.ok(declared().length >= 2,
      'scripts/repos.txt names fewer than two repositories - the defect this guards against cannot occur, so check why');
    assert.ok(declared().includes('djayamah/warden'), 'the private mirror must be in scope; it is the one that was missed');
    assert.ok(declared().includes('djayamah/usewarden'), 'the public repository must be in scope');
  });

  test('NO REMOTE CAN NARROW THE SWEEP — the file decides, everywhere', () => {
    // The first version made "declared but no remote configured" fatal, and CI failed on every
    // runner within minutes: a GitHub runner clones ONE repository and so has exactly one remote
    // by construction. That was the same mistake this script is about — letting an
    // environment-specific detail decide what "all of them" means. The file decides now.
    const r = run(['--dry-run']);
    assert.equal(r.status, 0, `scope could not be resolved:\n${r.stdout}${r.stderr}`);
    for (const slug of declared()) {
      assert.ok(r.stdout.includes(slug), `${slug} is declared but the sweep would not cover it`);
    }
    assert.match(r.stdout, new RegExp(`would sweep ${declared().length} repositor`));
  });

  test('a git remote nobody declared is a failure — a push target outside the sweep', () => {
    // The direction that IS meaningful on every machine, runner included: `origin` is always
    // declared, so this can only fire when someone adds a push target and forgets the list.
    const remotes = spawnSync('git', ['remote', '-v'], { encoding: 'utf8', cwd: REPO }).stdout ?? '';
    const configured = new Set(
      [...remotes.matchAll(/github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?\s/g)].map((m) => m[1]!),
    );
    for (const slug of configured) {
      assert.ok(declared().includes(slug),
        `a git remote points at ${slug} and scripts/repos.txt does not name it — that repository is outside the sweep`);
    }
    // And the rule is in the script, not only in this assertion.
    assert.match(fs.readFileSync(SCRIPT, 'utf8'), /does not name:/);
  });

  test('A NARROWED SWEEP CAN NEVER REPORT GREEN — this is the whole point', () => {
    // The first version of this script printed "ALL 1 REPOSITORY HEALTHY" when narrowed, which is
    // the precise sentence it exists to stop anyone from writing. Narrowing is loud and non-zero
    // by construction now.
    const r = run(['--dry-run', '--only=djayamah/usewarden']);
    assert.notEqual(r.status, 0, 'a sweep of one repository out of two must not exit 0');
    assert.match(r.stderr + r.stdout, /NARROWED SWEEP: 1 of 2/);
    assert.doesNotMatch(r.stdout, /=== ALL \d+ REPOSITOR\(Y\/IES\) HEALTHY ===/,
      'a narrowed run must never print the healthy banner');
  });

  test('an explicit count that does not match the set is a failure', () => {
    const r = run(['--dry-run', `--expect=${declared().length + 1}`]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /expected \d+ repositor/);
  });

  test('the list is read, never restated — no consumer carries its own copy', () => {
    // Same rule as scripts/internal-only-paths.txt, and for the same reason: two copies of one
    // list drift, and the drift goes unnoticed until something is silently out of scope.
    const script = fs.readFileSync(SCRIPT, 'utf8');
    assert.match(script, /repos\.txt/, 'repo-health.mjs must read the list from the file');
    for (const slug of declared()) {
      assert.ok(!script.includes(`'${slug}'`) && !script.includes(`"${slug}"`),
        `repo-health.mjs hard-codes ${slug} - the list must come from scripts/repos.txt alone`);
    }
  });

  test('it is wired into verify-all as a netgate, not merely present', () => {
    // A gate nobody runs is a gate that does not exist. `netgate`, not `gate`, because it needs
    // GitHub and "I could not look" is not "it is fine" (CLAUDE.md §4.4).
    const va = fs.readFileSync(path.join(REPO, 'scripts', 'verify-all.sh'), 'utf8');
    assert.match(va, /repo-health\.mjs/, 'verify-all.sh must run the repository health check');
    const line = va.slice(va.lastIndexOf('netgate', va.indexOf('repo-health.mjs')), va.indexOf('repo-health.mjs'));
    assert.match(line, /^netgate/, 'it must be a netgate so an unreachable GitHub is UNVERIFIED, not a pass');
  });
});
