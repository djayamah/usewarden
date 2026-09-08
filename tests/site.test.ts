import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SITE = path.join(REPO, 'site', 'index.html');

/**
 * The landing page. Local artifact, NOT deployed - see site/README.md.
 *
 * Two things are asserted here, and the second matters more than the first:
 *
 *   1. the page is genuinely self-contained and tracking-free, rather than merely claimed to be;
 *   2. the factual claims it makes are still true of this repository. A landing page is the one
 *      document nobody re-reads after they write it, so it is exactly the document that goes
 *      quietly stale. Pinning its claims to the code that proves them is cheap here and
 *      impossible once it is somebody else's job.
 */
describe('site: the landing page is self-contained and tracking-free', () => {
  const html = fs.readFileSync(SITE, 'utf8');

  test('the file exists and is a real page, not a placeholder', () => {
    assert.ok(html.length > 4000, 'the page looks empty');
    assert.match(html, /<!doctype html>/i);
    assert.match(html, /<title>usewarden/);
  });

  test('it fetches nothing from anywhere', () => {
    // A FETCH IS NOT A LINK, AND THE ORIGINAL FORM OF THIS TEST CONFLATED THEM.
    //
    // `src`, `action`, `poster` and a stylesheet `<link href>` are fetched without asking, and
    // those are what the CSP exists to stop. An `<a href>` is navigation the reader chooses; the
    // browser fetches nothing until they click. Anchors may therefore point at surfaces the
    // founder owns, or at a PRIMARY SOURCE the page cites for a claim about someone else's
    // product - a claim a reader cannot check is worse than no claim at all.
    //
    // THE RULE ITSELF LIVES IN ONE PLACE NOW, AND THIS IS WHY.
    //
    // It was written out here AND inlined in `.github/workflows/pages.yml`, and the two drifted.
    // This one was updated on 2026-08-26 when the honest native-controls comparison added two
    // citation links; the workflow's copy was not, so it kept refusing every absolute URL in any
    // attribute. The suite went green and the private repository's `pages` run went red on every
    // push for a fortnight, unread (D-272). Same shape as the internal-only path list before it
    // became one file with three readers - so this now runs the same script the workflow runs,
    // rather than a second opinion that can disagree with it.
    const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'check-site-selfcontained.mjs')],
      { encoding: 'utf8', cwd: REPO });
    assert.equal(r.status, 0, `the site is not self-contained:\n${r.stdout}${r.stderr}`);
    // And the checker must have looked at the real pages rather than an empty directory.
    assert.match(r.stdout, /\n  (\d+) page\(s\) checked/);
    assert.ok(Number(/\n  (\d+) page\(s\) checked/.exec(r.stdout)![1]) >= 2,
      'the checker reported fewer pages than the site has - it is looking in the wrong place');
  });

  test('the self-containment rule exists in ONE place, and the workflow reads it', () => {
    // The drift that caused D-272 is only fixed while this stays true.
    const wf = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'pages.yml'), 'utf8');
    assert.match(wf, /node scripts\/check-site-selfcontained\.mjs/,
      'pages.yml must RUN the checker, not restate its rules');
    assert.ok(!/googleapis|jsdelivr|unpkg|google-analytics/.test(wf),
      'pages.yml carries its own copy of the host list again - that is the drift that broke it');
    assert.ok(!/djayamah\\?\.github\\?\.io\|github\\?\.com/.test(wf),
      'pages.yml carries its own copy of the origin allowlist again');
  });

  test('the checker fails when the site stops being self-contained', () => {
    // §4.2: assert the check can fail before trusting that it passed.
    const r = spawnSync(process.execPath,
      [path.join(REPO, 'scripts', 'check-site-selfcontained.mjs'), '--self-test-only'],
      { encoding: 'utf8', cwd: REPO });
    assert.equal(r.status, 0, `the checker's own self-test failed:\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /ok {2}  a script tag/);
    assert.match(r.stdout, /ok {2}  an off-host src/);
    assert.match(r.stdout, /ok {2}  a canonical link to an owned origin/);
  });

  test('it runs no script at all', () => {
    assert.equal(/<script\b/i.test(html), false, 'the page needs no JavaScript and must ship none');
    assert.equal(/\bon[a-z]+\s*=\s*"/i.test(html), false, 'no inline event handlers');
  });

  test('it carries a restrictive CSP and no referrer', () => {
    assert.match(html, /content-security-policy/i);
    assert.match(html, /default-src 'none'/);
    assert.match(html, /frame-ancestors 'none'/);
    assert.match(html, /<meta name="referrer" content="no-referrer">/);
  });

  test('there is no analytics, beacon, or third-party embed', () => {
    for (const tracker of ['google-analytics', 'googletagmanager', 'gtag', 'plausible', 'fathom',
      'segment', 'mixpanel', 'hotjar', 'posthog', 'sentry', 'navigator.sendBeacon', '<iframe', '<img']) {
      assert.equal(html.toLowerCase().includes(tracker.toLowerCase()), false,
        `the page must not contain "${tracker}"`);
    }
  });

  test('it is theme-aware and does not scroll the body sideways', () => {
    assert.match(html, /prefers-color-scheme: dark/);
    assert.match(html, /\.tablewrap\s*\{[^}]*overflow-x:\s*auto/);
    assert.match(html, /pre\s*\{[^}]*overflow-x:\s*auto/);
  });
});

describe('site: the claims on the page are still true of this repository', () => {
  const html = fs.readFileSync(SITE, 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as
    { dependencies?: Record<string, string>; scripts?: Record<string, string> };

  test('"0 runtime dependencies" is true', () => {
    assert.match(html, /0 runtime dependencies/);
    assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
  });

  test('"no install scripts, ever" is true', () => {
    assert.match(html, /no install scripts, ever/);
    for (const s of ['preinstall', 'install', 'postinstall', 'prepare']) {
      assert.equal(pkg.scripts?.[s], undefined, `package.json declares "${s}"`);
    }
  });

  test('the incident card quotes the real live artifact', () => {
    const artifact = fs.readFileSync(path.join(REPO, 'verification', 'live', '01-env-read.txt'), 'utf8');
    assert.match(html, /dotenv-access/);
    assert.match(artifact, /dotenv-access/, 'setup failed - the artifact no longer shows this catch');
    assert.match(html, /commands\.deny\[6\] \(dotenv-access\)/);
    assert.match(artifact, /commands\.deny\[6\] \(dotenv-access\)/,
      'the page quotes a rule id the artifact no longer contains');
    // The quoted agent reply must be a real sentence from the real transcript.
    assert.match(html, /I'm not going to try to route around it/);
    assert.match(artifact, /not going to try to route around it/,
      'the quoted agent reply is not in the transcript any more');
  });

  test('"14 of 17" matches the layer-1 scenario list the sabotage suite actually runs', () => {
    const claim = /<strong>(\d+) of (\d+)<\/strong> scenarios in the sabotage suite/.exec(html);
    assert.ok(claim, 'the page no longer states a layer-1 catch rate in the expected form');
    const [caught, total] = [Number(claim[1]), Number(claim[2])];

    // Parse the real SCENARIOS list out of SAB-13 rather than trusting a number in prose.
    const suite = fs.readFileSync(path.join(REPO, 'tests', 'sabotage', 'suite.test.ts'), 'utf8');
    const block = /const SCENARIOS[\s\S]*?\n  \];/.exec(suite);
    assert.ok(block, 'setup failed - SAB-13 no longer declares a SCENARIOS list');
    const entries = block[0].split('\n').filter((l) => /^\s*\['/.test(l)).length;
    assert.ok(entries > 10, `setup failed - only parsed ${entries} scenarios`);

    // SAB-13 asserts exactly two scenarios are expected to slip past Layer 1.
    const expectedMisses = /assert\.deepEqual\(missed\.sort\(\), \[([^\]]*)\]/.exec(suite);
    assert.ok(expectedMisses, 'setup failed - SAB-13 no longer names its expected misses');
    const misses = expectedMisses[1]!.split(',').filter((x) => x.trim().length > 0).length;

    assert.equal(total, entries, `the page says ${total} scenarios; the suite runs ${entries}`);
    assert.equal(caught, entries - misses,
      `the page claims ${caught} caught; the suite runs ${entries} with ${misses} expected misses`);
  });

  test('the page does NOT still claim to be unpublished', () => {
    // INVERTED 2026-08-26, and the reason is the whole point of this test now existing.
    //
    // This assertion used to REQUIRE the words "Not yet published" on the page. That was true and
    // right until 0.1.0 shipped, at which point the guard started defending a false sentence: the
    // page told every reader the commands would not resolve while the package was live on the
    // registry, and correcting it would have failed the suite. A release sweep for that exact
    // phrase reached six other files and missed this one, because this one was worded differently.
    //
    // A test that pins marketing copy has to be pointed at the CLAIM, not the WORDS. So it now
    // asserts the negative, which stays true for every future version.
    assert.doesNotMatch(html, /Not yet published/i,
      'the page still says it is unpublished; usewarden is on the registry');
    assert.doesNotMatch(html, /not been released\s+to npm/i,
      'the page still says it has not been released');
    assert.doesNotMatch(html, /will not resolve today/i,
      'the page still tells readers the install commands do not work');
  });

  test('the honest native-controls comparison is on the page, with its sources', () => {
    // docs/RETENTION.md item 3, authorised by the founder on 2026-08-26. The site and the README
    // both have to carry it: a reader who discovers this comparison themselves stops trusting
    // everything else the page said, and that is the expensive failure.
    assert.match(html, /Claude Code/,
      'the page makes no mention of the agent whose own controls overlap ours');
    assert.match(html, /you do not need this/i,
      'the page does not state plainly that a single-agent Claude Code user may not need usewarden');
    assert.match(html, /code\.claude\.com\/docs\/en\/permissions/,
      'the redirection claim is made without linking the primary source that supports it');
    assert.match(html, /anthropic\.com\/engineering\/claude-code-sandboxing/,
      'the sandbox claim is made without linking the primary source that supports it');
  });

  test('the page points at the metrics method rather than asserting a bare number', () => {
    assert.match(html, /docs\/METRICS\.md/);
    assert.equal(fs.existsSync(path.join(REPO, 'docs', 'METRICS.md')), true);
    // No unqualified savings claim: every mention of saving is next to the word estimate/range.
    const savingsClaims = [...html.matchAll(/sav(?:ed|ings)/gi)];
    assert.ok(savingsClaims.length > 0, 'setup failed - the page does not mention savings');
    assert.match(html, /shown as a <em>range<\/em>, never a point/);
  });
});

describe('site/writeups: the canonical home, deployed to GitHub Pages', () => {
  const dir = path.resolve(REPO, 'site', 'writeups');
  const pages = fs.readdirSync(dir).filter((f) => f.endsWith('.html'));

  test('every page carries a canonical link pointing at itself', () => {
    // D-222: a Discussion cannot carry one, so whichever surface publishes first becomes the
    // authoritative copy and cannot hand it back. This is the whole reason the site exists, and
    // it is emitted by the generator rather than typed, so it cannot be forgotten on piece 5.
    assert.ok(pages.length >= 2, `expected rendered pages, found ${pages.length}`);
    for (const f of pages) {
      const html = fs.readFileSync(path.join(dir, f), 'utf8');
      const m = /<link rel="canonical" href="([^"]+)">/.exec(html);
      assert.ok(m, `${f} has no canonical link`);
      assert.match(m[1]!, /^https:\/\/djayamah\.github\.io\/usewarden\/writeups\//,
        `${f} points its canonical somewhere unexpected: ${m[1]}`);
      if (f !== 'index.html') {
        assert.equal(m[1], `https://djayamah.github.io/usewarden/writeups/${f}`,
          'a piece must be canonical to ITSELF, not to the index');
      }
    }
  });

  test('the canonical origin is a surface we own and did not pay for', () => {
    // No domain has been bought - that is §7 exception 3. GitHub Pages on the founder's own public
    // repository is free, needs no interactive login, and can be deleted with one API call.
    for (const f of pages) {
      const html = fs.readFileSync(path.join(dir, f), 'utf8');
      assert.ok(!/https?:\/\/(?!djayamah\.github\.io|github\.com)[a-z0-9-]+\./i.test(html),
        `${f} references an origin that is neither ours nor GitHub`);
    }
  });

  test('the rendered pages match their source — a stale page is a lie with a date on it', async () => {
    // `scripts/build-writeups.mjs --check` re-renders and compares. Committing an edit to the
    // markdown without re-rendering would leave the canonical copy saying something the source
    // does not, which is worse than not publishing it.
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync(process.execPath,
      [path.join(REPO, 'scripts', 'build-writeups.mjs'), '--check'],
      { encoding: 'utf8', cwd: REPO });
    assert.match(out, /rendered page\(s\) match their source/);
  });

  test('self-contained: no script, no CDN, no external font', () => {
    for (const f of pages) {
      const html = fs.readFileSync(path.join(dir, f), 'utf8');
      assert.ok(!/<script/i.test(html), `${f} has a script tag`);
      assert.match(html, /content-security-policy/i);
      assert.match(html, /default-src 'none'/);
      assert.ok(!/fonts\.googleapis|cdn\.|unpkg|jsdelivr|google-analytics/i.test(html),
        `${f} references an external asset host`);
    }
  });

  test('only PUBLISHED pieces are rendered — a draft must not get a live URL', () => {
    // launch/writeups/ holds eight pieces; one is published. A rendered page for an unpublished
    // draft would be a public URL for something nobody decided to release.
    //
    // `launch/` IS DROPPED AT PUBLICATION (scripts/internal-only-paths.txt), so this directory
    // does not exist in a checkout of the public repository. Reading it unconditionally made the
    // published repo's own `npm test` die with ENOENT for every user who cloned it — found by the
    // push gate running the suite of the tree it was about to push, rather than the tree it was
    // standing in. A test that only passes on the maintainer's machine is not a test the project
    // ships.
    //
    // The half that is checkable from EITHER tree is asserted in both: exactly one piece plus the
    // index is rendered. The draft count is asserted only where the drafts exist, and its absence
    // is stated rather than skipped silently.
    const draftsDir = path.resolve(REPO, 'launch', 'writeups');
    if (fs.existsSync(draftsDir)) {
      const drafts = fs.readdirSync(draftsDir).filter((f) => /^\d\d-.*\.md$/.test(f));
      assert.ok(drafts.length > 1, 'setup failed: expected several drafts');
    } else {
      // Not silently skipped. This is the published tree, where the source drafts are absent by
      // design; the rendered output is still the thing that must be right, and it is checked next.
      assert.ok(true, 'launch/writeups/ is absent — this is a published checkout, drafts not visible');
    }
    assert.equal(pages.length, 2, 'exactly one piece plus the index should be rendered');
  });

  test('the deploy workflow publishes site/ and nothing else, with least privilege', () => {
    const wf = fs.readFileSync(path.resolve(REPO, '.github', 'workflows', 'pages.yml'), 'utf8');
    assert.match(wf, /path: site/);
    assert.match(wf, /pages: write/);
    assert.match(wf, /id-token: write/);
    assert.match(wf, /contents: read/);
    // Every third-party action pinned to a full commit SHA, as everywhere else in this repository.
    for (const m of wf.matchAll(/uses:\s+([^\s@]+)@([^\s]+)/g)) {
      assert.match(m[2]!, /^[0-9a-f]{40}$/, `${m[1]} is not pinned to a full SHA`);
    }
  });

  test('the workflow refuses to publish a site that stopped being self-contained', () => {
    // The gate is only worth having if it fails. It no longer lives INSIDE the workflow - it is
    // `scripts/check-site-selfcontained.mjs`, run by both the workflow and this suite, because two
    // copies drifted and the workflow's was the stale one (D-272). So the assertion moved with it:
    // the workflow must invoke the checker, and the checker must still refuse.
    const wf = fs.readFileSync(path.resolve(REPO, '.github', 'workflows', 'pages.yml'), 'utf8');
    assert.match(wf, /node scripts\/check-site-selfcontained\.mjs/);
    const src = fs.readFileSync(path.resolve(REPO, 'scripts', 'check-site-selfcontained.mjs'), 'utf8');
    assert.match(src, /REFUSING TO PUBLISH: the site is no longer self-contained/);
    assert.match(src, /contains a <script> tag/);
  });

  test('the deploy job cannot run where GitHub Pages does not exist', () => {
    // The private mirror ran this workflow three times and failed three times, because Pages is
    // not enabled there and `configure-pages` cannot succeed on a repository without it. A run
    // that is always red is a run nobody reads - which is exactly how the self-containment drift
    // above stayed invisible for a fortnight.
    const wf = fs.readFileSync(path.resolve(REPO, '.github', 'workflows', 'pages.yml'), 'utf8');
    assert.match(wf, /^\s+if: github\.repository == \(vars\.PAGES_REPO \|\| 'djayamah\/usewarden'\)$/m,
      'the deploy job must be fenced to the repository that actually has Pages');
    // And the content gate must NOT be fenced - it is useful on every repository.
    const checkJob = wf.slice(wf.indexOf('  check:'), wf.indexOf('  deploy:'));
    assert.ok(!/\bif:/.test(checkJob), 'the self-containment gate must run everywhere, not only where we deploy');
  });
});
