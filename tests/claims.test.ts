import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * THE CLAIMS AN ADVERSARIAL READER WOULD ATTACK, PINNED ON THE TREE THAT SHIPS.
 *
 * This file is deliberately standalone: it imports nothing from `src/`, so it runs unchanged in
 * the private repository and in the published one. That is the entire point of it.
 *
 * There was already a guard for this, in `tests/packaging.test.ts`, and it had two holes that
 * together let the rejected claim reach the npm registry (DECISIONS.md D-095, D-171):
 *
 *   1. It only covered the places we WRITE marketing — README, the post drafts, the landing page.
 *      It did not cover `package.json`'s `description`, which is the sentence npmjs.com prints
 *      under the package name, or `src/cli.ts`'s usage banner, which is what `usewarden --help`
 *      prints. Both still said "a firewall for your AI coding agents".
 *
 *   2. `tests/packaging.test.ts` is **not published**. It imports private-only helpers from
 *      `src/telemetry.js` that the public tree does not export, so it cannot run there at all.
 *      The guard existed exclusively in the repository that does not ship.
 *
 * A guard aimed at the copy we review, in a tree that never ships, is a guard that passes while
 * the claim goes out. This one runs where the artifact is built.
 *
 * Why "firewall" is the claim being pinned: usewarden intercepts what an agent DECLARES it is
 * about to do, through that agent's own hook system. It is not a chokepoint and not a sandbox,
 * and "firewall" promises containment it cannot deliver. Saying so in the README while the CLI
 * banner says the opposite is worse than either alone.
 */
describe('claims: what an adversarial reader would attack first', () => {
  const candidates: [string, string[]][] = [
    ['README.md', ['README.md']],
    ['package.json (the sentence npmjs.com prints)', ['package.json']],
    ['src/cli.ts (what `usewarden --help` prints)', ['src', 'cli.ts']],
    ['site/index.html', ['site', 'index.html']],
    ['launch/POSTS.md', ['launch', 'POSTS.md']],
    ['scripts/build-publish-tree.sh (the publication commit message)',
      ['scripts', 'build-publish-tree.sh']],
  ];

  const surfaces: [string, string][] = [];
  const absent: string[] = [];
  for (const [name, parts] of candidates) {
    const p = path.join(REPO, ...parts);
    if (fs.existsSync(p)) surfaces.push([name, fs.readFileSync(p, 'utf8')]);
    else absent.push(name);
  }

  test('enough surfaces are readable for this guard to mean anything', () => {
    // A guard that silently shrinks to nothing still reports PASS. `launch/` is internal-only and
    // is legitimately absent from a public checkout; README, package.json and src/cli.ts are not,
    // and all three ship. If fewer than those three are readable, something is wrong with the
    // checkout and this file must say so rather than pass on an empty list.
    assert.ok(surfaces.length >= 3,
      `only ${surfaces.length} surface(s) readable; absent: ${absent.join(', ') || 'none'}`);
    for (const required of ['README.md', 'package.json (the sentence npmjs.com prints)',
      'src/cli.ts (what `usewarden --help` prints)']) {
      assert.ok(surfaces.some(([n]) => n === required), `${required} must be readable and was not`);
    }
  });

  for (const [name, body] of surfaces) {
    test(`${name} does not call usewarden a firewall`, () => {
      for (const m of body.matchAll(/firewall/gi)) {
        const at = m.index ?? 0;
        const around = body.slice(Math.max(0, at - 100), at + 40);
        assert.match(around, /not a firewall|call it a "firewall"|firewalled/i,
          `${name} uses "firewall" as a claim: ...${around.replace(/\s+/g, ' ').trim()}...`);
      }
    });
  }

  test('the npm description is the approved framing, not a paraphrase of it', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as
      { description?: string };
    const d = pkg.description ?? '';
    assert.ok(d.length > 0, 'package.json has no description; npmjs.com would show nothing');
    assert.doesNotMatch(d, /firewall/i, 'the npm description calls it a firewall');
    // The one load-bearing word. "guardrail" is the framing the adversarial read landed on and the
    // one the site title and README both use; a future edit that drifts away from it should have
    // to change this line deliberately.
    assert.match(d, /guardrail/i,
      'the npm description no longer says "guardrail" - if that is intended, change this test on purpose');
  });
});
