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

  // -------------------------------------------------------------------------------------------
  // THE HONEST COMPARISON AGAINST THE AGENT'S OWN CONTROLS (added 2026-08-26)
  //
  // docs/RETENTION.md item 3, authorised by the founder. Claude Code's own deny rules match
  // usewarden for blocking, and for writes that leave the project they BEAT it: Claude Code checks
  // shell redirection targets as file writes, and its OS sandbox confines subprocesses. usewarden
  // does neither, measured: 0 of 3 and 0 of 2 in verification/native-comparison/01-what-fires.txt.
  //
  // This is pinned because it is the single most deletable paragraph in the README. It reads like
  // a sentence that undersells the product, so a future edit tidies it away - and the reason it is
  // there is not visible from the paragraph itself. The reason is that a reader who works this out
  // on their own stops trusting every other claim on the page, and there is no recovering from
  // that. Deleting it should cost a deliberate change to this test.
  // -------------------------------------------------------------------------------------------
  test('the README says plainly that native controls may be enough, and better in one respect', () => {
    const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
    assert.match(readme, /you do not need this/i,
      'the README no longer tells a single-agent Claude Code user they may not need usewarden');
    assert.match(readme, /redirect/i,
      'the README no longer names the shell-redirect gap');
    assert.match(readme, /sandbox/i,
      'the README no longer names the OS sandbox that covers what usewarden cannot');
    // And the sources, because a claim about someone else's product without their documentation
    // behind it is the kind of thing a reader is right to disbelieve.
    assert.match(readme, /code\.claude\.com\/docs\/en\/permissions/,
      'the redirection claim has lost its primary source');
    assert.match(readme, /anthropic\.com\/engineering\/claude-code-sandboxing/,
      'the sandbox claim has lost its primary source');
  });

  test('the README does not claim usewarden blocks things the agent natively cannot', () => {
    const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
    // USING versus NAMING - the same distinction the "firewall" test above makes, and this test
    // failed on its own subject the first time it ran. The README RETIRES this claim by quoting
    // it: 'the honest pitch is not "we block things Claude Code cannot"'. A bare pattern match
    // cannot tell the retraction from the claim, so the preceding words are inspected, exactly as
    // the firewall check does. That is D-091 arriving for the third time in this repository.
    for (const m of readme.matchAll(/\bblocks? (?:things|what) (?:your |the )?(?:agent|Claude Code)[^.]*cannot\b/gi)) {
      const before = readme.slice(Math.max(0, (m.index ?? 0) - 60), m.index ?? 0);
      assert.match(before, /\bnot\b[^.]*$|never\b[^.]*$/i,
        `the README makes the claim the comparison exists to retire: "${m[0]}"`);
    }
  });

  // -------------------------------------------------------------------------------------------
  // STALENESS. The npm README is baked into the tarball at publish time and cannot be corrected
  // without a version bump (D-239), so a sentence that has quietly become false is a release
  // defect rather than a typo. The site carried "Not yet published ... will not resolve today"
  // for two published versions, because the release sweep grepped for a phrase and this file was
  // worded differently. Pinned by CLAIM here rather than by phrase.
  // -------------------------------------------------------------------------------------------
  for (const [name, body] of surfaces) {
    test(`${name} does not still say usewarden is unpublished`, () => {
      for (const re of [/not yet published/i, /not been released to npm/i,
        /not installable from npm/i, /will not resolve today/i, /no npm package yet/i]) {
        assert.doesNotMatch(body, re,
          `${name} still tells the reader usewarden is not on the registry; it has been since 0.1.0`);
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
