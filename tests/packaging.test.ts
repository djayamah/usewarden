import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import {
  buildPayload, consentDigest, consentIsCurrent, endpoint, grantConsent, isSafeLabel, purgeRecorded,
  readConsent, record, revokeConsent, SCHEMA_VERSION, telemetryEnabled, telemetryOffReason,
} from '../src/telemetry.js';
import { sandbox, type Sandbox } from './helpers.js';
import { displayPath, isInside } from '../src/util.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * T-01: the ChainDrop assertion.
 *
 * The single most important test in the repository, because it is the one that would have
 * stopped the 4 August 2026 worm from using usewarden as a carrier. It fails the build if an
 * install script ever appears - in usewarden's own manifest, or anywhere in the committed lockfile.
 */
const FORBIDDEN_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish'];

/**
 * IS THIS A CHECKOUT OF THE PRIVATE REPOSITORY?
 *
 * Some of the tests below are about this project's own GOVERNANCE — the pre-push guard, which
 * reads CLAUDE.md §7 at push time; the launch drafts under `launch/`; and the assertion that the
 * publisher really drops what `scripts/internal-only-paths.txt` names. Every one of those subjects
 * is itself internal-only and is dropped by `scripts/build-publish-tree.sh`, so in a checkout of
 * the PUBLIC repository they cannot pass, and until 2026-09-08 nothing had noticed, because
 * nothing had ever run this suite anywhere but here.
 *
 * They are SKIPPED WITH A REASON rather than deleted, made conditional inside the body, or left to
 * fail. A skipped test with a stated reason is visible in the output and counted separately; a
 * body that quietly returns early looks exactly like a body that passed. That distinction is
 * CLAUDE.md §4.4 applied to the suite itself.
 *
 * CLAUDE.md is the sentinel because it is the file the publisher is most certain to drop — the
 * operator's path fence only works if it names the real private paths, so it can never be
 * redacted-and-published.
 */
const PRIVATE_TREE = fs.existsSync(path.join(REPO, 'CLAUDE.md'));
const ONLY_PRIVATE = PRIVATE_TREE
  ? {}
  : { skip: 'published checkout: this tests the private repo\'s own governance, whose subject files publication drops' };

describe('T-01: no install scripts, anywhere', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as
    { scripts?: Record<string, string>; dependencies?: Record<string, string>; files?: string[]; bin?: Record<string, string>; engines?: Record<string, string> };

  test("usewarden's own package.json declares none of the four lifecycle hooks", () => {
    for (const s of FORBIDDEN_SCRIPTS) {
      assert.equal(pkg.scripts?.[s], undefined,
        `package.json must not declare "${s}" - that is the exact ChainDrop mechanism`);
    }
  });

  test('usewarden has ZERO runtime dependencies', () => {
    assert.deepEqual(pkg.dependencies ?? {}, {},
      'every runtime dependency is another install-script surface; usewarden has none');
  });

  test('the lockfile is committed and contains no install script in any entry', () => {
    const lockPath = path.join(REPO, 'package-lock.json');
    assert.equal(fs.existsSync(lockPath), true, 'the lockfile MUST be committed');
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as
      { packages?: Record<string, { hasInstallScript?: boolean; scripts?: Record<string, string> }> };
    const offenders: string[] = [];
    for (const [name, entry] of Object.entries(lock.packages ?? {})) {
      if (entry.hasInstallScript) offenders.push(`${name}: hasInstallScript`);
      for (const s of FORBIDDEN_SCRIPTS) {
        if (entry.scripts?.[s]) offenders.push(`${name}: ${s}`);
      }
    }
    assert.deepEqual(offenders, [], 'no dependency, transitive or otherwise, may run code on install');
  });

  test('the lockfile pins every dependency to an integrity hash', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(REPO, 'package-lock.json'), 'utf8')) as
      { packages?: Record<string, { resolved?: string; integrity?: string; link?: boolean }> };
    const unpinned: string[] = [];
    for (const [name, e] of Object.entries(lock.packages ?? {})) {
      if (name === '' || e.link) continue;
      if (!e.integrity) unpinned.push(name);
    }
    assert.deepEqual(unpinned, []);
  });
});

describe('package manifest sanity', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as
    { files?: string[]; bin?: Record<string, string>; engines?: Record<string, string>; license?: string };

  test('engines pins the supported LTS floor', () => {
    assert.equal(pkg.engines?.['node'], '>=22.13.0',
      'Node 22 and 24 are the Active LTS lines; 22.13.0 is where node:sqlite stopped needing a flag');
  });

  test('the bin entry exists after a build', () => {
    const bin = pkg.bin?.['usewarden'];
    assert.ok(bin);
    assert.equal(fs.existsSync(path.join(REPO, bin!)), true, `${bin} must exist - run npm run build`);
  });

  test('the files allowlist never ships source, tests, fixtures or verification artifacts', () => {
    const files = pkg.files ?? [];
    assert.ok(files.length > 0, 'an explicit files allowlist is safer than .npmignore');
    // `service` and `site` are built-but-not-deployed artifacts (service/README.md,
    // site/README.md). Neither belongs in a package a user installs, and `dist/src` - not
    // `dist` - is what the allowlist names, so their compiled output does not ship either.
    for (const bad of ['src', 'tests', 'fixtures', 'verification', '.usewarden-live', 'scripts',
      'service', 'site', 'dist', 'bots', 'ops']) {
      assert.equal(files.includes(bad), false, `"${bad}" must not be published`);
    }
    assert.equal(files.includes('dist/src'), true, 'only the CLI build is published');
  });

  /**
   * The aggregation service and the landing page are deliberately NOT deployed and NOT shipped.
   * This asserts the second half of that: nothing under service/ or site/ can reach a tarball,
   * and the client carries no hostname that would point at a deployed one.
   */
  test('the built-but-not-deployed artifacts stay out of the package and out of the client', () => {
    assert.equal(fs.existsSync(path.join(REPO, 'service', 'README.md')), true, 'setup failed - no service');
    assert.equal(fs.existsSync(path.join(REPO, 'site', 'index.html')), true, 'setup failed - no site');

    // The client must carry no telemetry hostname. The endpoint is user-supplied or nothing, so
    // there is nothing here for a default to accidentally point at.
    const telemetry = fs.readFileSync(path.join(REPO, 'src', 'telemetry.ts'), 'utf8');
    const hosts = telemetry.match(/\/\/[a-z0-9-]+(\.[a-z0-9-]+)+/gi) ?? [];
    assert.deepEqual(hosts, [], `src/telemetry.ts names a host: ${hosts.join(', ')}`);

    // Nothing in the shipped source may import the not-deployed trees.
    const srcFiles = fs.readdirSync(path.join(REPO, 'src'), { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts'));
    assert.ok(srcFiles.length > 10, 'setup failed - src looks empty');
    for (const f of srcFiles) {
      const body = fs.readFileSync(path.join(REPO, 'src', f), 'utf8');
      assert.equal(/from ['"][^'"]*(service|site)\//.test(body), false,
        `src/${f} imports a not-deployed tree`);
    }
  });

  test('LICENSE is MIT and the file is present', () => {
    assert.equal(pkg.license, 'MIT');
    assert.equal(fs.existsSync(path.join(REPO, 'LICENSE')), true);
  });
});

describe('T-15: telemetry', () => {
  let sb: Sandbox;
  let store: Store;
  const saved: Record<string, string | undefined> = {};
  const KEYS = ['DO_NOT_TRACK', 'USEWARDEN_TELEMETRY', 'USEWARDEN_TELEMETRY_ENDPOINT'];

  beforeEach(() => {
    sb = sandbox();
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    store = new Store(path.join(sb.usewardenHome, 'w.db'));
  });
  afterEach(() => {
    store.close();
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    sb.cleanup();
  });

  test('off by default', () => {
    assert.equal(telemetryEnabled(store), false);
  });

  /** Opting in the way the CLI does: the setting AND a consent receipt. */
  const optIn = (): void => { store.setMeta('telemetry', 'on'); grantConsent('0.1.0'); };

  test('DO_NOT_TRACK=1 overrides an explicit opt-in', () => {
    optIn();
    assert.equal(telemetryEnabled(store), true);
    process.env['DO_NOT_TRACK'] = '1';
    assert.equal(telemetryEnabled(store), false);
    assert.equal(telemetryOffReason(store), 'do_not_track');
  });

  test('USEWARDEN_TELEMETRY=0 overrides an explicit opt-in', () => {
    optIn();
    assert.equal(telemetryEnabled(store), true);
    process.env['USEWARDEN_TELEMETRY'] = '0';
    assert.equal(telemetryEnabled(store), false);
    assert.equal(telemetryOffReason(store), 'env_override');
  });

  // ---- consent -------------------------------------------------------------------------
  // "Off by default" is necessary and not sufficient. These assert that the SETTING alone
  // grants nothing, and that consent does not survive a change to what is being consented to.

  test('the setting alone does not enable telemetry - a consent receipt is required', () => {
    store.setMeta('telemetry', 'on');
    // sabotage landed: the setting really does say on.
    assert.equal(store.getMeta('telemetry'), 'on');
    assert.equal(readConsent(), null, 'setup failed - a receipt already exists');
    assert.equal(telemetryEnabled(store), false, 'a database flag must not be enough to opt a user in');
    assert.equal(telemetryOffReason(store), 'consent_lapsed');
  });

  test('a consent receipt names the schema version and every field it covers', () => {
    const r = grantConsent('0.1.0');
    assert.equal(r.schema_version, SCHEMA_VERSION);
    assert.deepEqual([...r.fields].sort(),
      ['agents', 'checklist', 'counts', 'node', 'platform', 'rules', 'usewarden', 'v']);
    assert.equal(r.digest, consentDigest(r.fields, SCHEMA_VERSION));
    assert.equal(consentIsCurrent(r), true);
  });

  test('consent lapses when the payload schema changes', () => {
    optIn();
    assert.equal(telemetryEnabled(store), true);
    // A receipt from an older schema is exactly what a version bump leaves behind.
    const stale = { ...readConsent()!, schema_version: SCHEMA_VERSION - 1 };
    stale.digest = consentDigest(stale.fields, stale.schema_version);
    fs.writeFileSync(path.join(sb.usewardenHome, 'telemetry', 'consent.json'), JSON.stringify(stale));
    assert.equal(consentIsCurrent(readConsent()), false);
    assert.equal(telemetryEnabled(store), false, 'a yes to schema v0 must not cover schema v1');
    assert.equal(telemetryOffReason(store), 'consent_lapsed');
  });

  test('a receipt edited to cover more than it names is rejected', () => {
    optIn();
    const forged = readConsent()!;
    // sabotage: widen the field list while keeping the original digest.
    forged.fields = [...forged.fields, 'transcript'];
    fs.writeFileSync(path.join(sb.usewardenHome, 'telemetry', 'consent.json'), JSON.stringify(forged));
    assert.equal(readConsent()!.fields.includes('transcript'), true, 'setup failed - the edit did not land');
    assert.equal(consentIsCurrent(readConsent()), false, 'the digest must bind the field list');
    assert.equal(telemetryEnabled(store), false);
  });

  test('revoking consent turns telemetry off, and --purge deletes what was recorded', () => {
    optIn();
    const file = record(store, buildPayload(store, '0.1.0', ['claude'], []));
    assert.equal(fs.existsSync(file), true, 'setup failed - nothing was recorded');
    revokeConsent();
    assert.equal(telemetryEnabled(store), false);
    const purged = purgeRecorded();
    assert.equal(purged, file);
    assert.equal(fs.existsSync(file), false, 'purge must actually delete the local payloads');
  });

  test('v1 has no endpoint, and a non-https endpoint is refused', () => {
    assert.equal(endpoint(), null);
    process.env['USEWARDEN_TELEMETRY_ENDPOINT'] = 'http://insecure.invalid/t';
    assert.equal(endpoint(), null, 'plain http must never be used');
    process.env['USEWARDEN_TELEMETRY_ENDPOINT'] = 'https://example.invalid/t';
    assert.equal(endpoint(), 'https://example.invalid/t');
  });

  test('the payload contains no path, prompt, command, or file content', () => {
    const secretPath = '/Users/someone/secret-project/.env';
    store.addIncident({
      sessionId: 's', agent: 'claude', ts: Date.now(), layer: 1, severity: 'block', action: 'block',
      rule: 'commands.deny[6] (dotenv-access)', title: 'Blocked command: dotenv-access',
      attempted: `$ cat ${secretPath}`, reason: 'blocked', tool: 'Bash', target: secretPath, cwd: '/Users/someone/secret-project',
    }, true);
    // sabotage landed: the sensitive strings really are in the database.
    assert.match(store.recentIncidents()[0]!.target, /secret-project/);

    const payload = buildPayload(store, '0.1.0', ['claude'], ['agents_detected']);
    const serialized = JSON.stringify(payload);
    for (const f of ['secret-project', '/Users/', '.env', 'cat ', 'Blocked command']) {
      assert.equal(serialized.includes(f), false, `payload leaked ${JSON.stringify(f)}: ${serialized}`);
    }
    assert.deepEqual(Object.keys(payload).sort(),
      ['agents', 'checklist', 'counts', 'node', 'platform', 'rules', 'usewarden', 'v']);
    assert.deepEqual(payload.rules, { 'dotenv-access': 1 }, 'only usewarden-owned rule ids');
    assert.equal(payload.counts.actions_blocked, 1);
  });

  /**
   * The wire is subject to the same anti-inflation rule as the dashboard: a demo run must not
   * be able to move a number that leaves the machine. Sabotage landed first - the demo incident
   * really is in the database before the payload is asserted to ignore it.
   */
  test('a demo incident never reaches the payload', () => {
    const demoIncident = {
      sessionId: 'd', agent: 'claude' as const, ts: Date.now(), layer: 1 as const, severity: 'block' as const,
      action: 'block' as const, rule: 'commands.deny[0] (curl-pipe-sh)', title: 'Blocked command',
      attempted: '$ curl x | sh', reason: 'demo', tool: 'Bash', target: 'curl x | sh', cwd: '/tmp/x',
    };
    store.addIncident(demoIncident, false, 'demo');
    assert.equal(store.incidentsByOrigin('demo').length, 1, 'setup failed - no demo incident stored');

    const payload = buildPayload(store, '0.1.0', ['claude'], []);
    assert.equal(payload.counts.actions_blocked, 0, 'a demo run moved a number that would leave the machine');
    assert.deepEqual(payload.rules, {}, 'a demo rule id must not be reported');
  });

  test('a rule label that could be user data is dropped rather than sent', () => {
    assert.equal(isSafeLabel('dotenv-access'), true);
    assert.equal(isSafeLabel('scope.allowed_paths'), true);
    assert.equal(isSafeLabel('/Users/me/thing'), false);
    assert.equal(isSafeLabel('sk-ant-abc'), false);
    assert.equal(isSafeLabel('https://x'), false);
    assert.equal(isSafeLabel('a'.repeat(200)), false);
  });

  test('recording is local-only and appends JSONL under USEWARDEN_HOME', () => {
    const payload = buildPayload(store, '0.1.0', ['claude'], []);
    const file = record(store, payload);
    assert.ok(file.startsWith(sb.usewardenHome), 'nothing may be written outside USEWARDEN_HOME');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8').trim()).v, 1);
  });

  test('the documented schema and the actual payload agree field for field', () => {
    const doc = fs.readFileSync(path.join(REPO, 'docs', 'TELEMETRY.md'), 'utf8');
    const payload = buildPayload(store, '0.1.0', ['claude'], []);
    for (const k of Object.keys(payload)) {
      assert.match(doc, new RegExp(`\\b${k}\\b`), `docs/TELEMETRY.md does not document the "${k}" field`);
    }
    for (const k of Object.keys(payload.counts)) {
      assert.match(doc, new RegExp(`\\b${k}\\b`), `docs/TELEMETRY.md does not document counts.${k}`);
    }
  });
});

/**
 * The pre-push guard.
 *
 * CLAUDE.md section 7 lists four permanently forbidden actions and the first is pushing to the
 * PUBLIC repository. A rule in a document is a rule a tired human or a confident agent walks
 * past, so it is also a control - and a control gets tested like one.
 *
 * The important case is the third: the hook must match on the resolved URL, never on the
 * remote's NAME. `git push public` and `git push https://github.com/djayamah/usewarden.git` are
 * the same action, and a remote can be renamed. That is the same class of mistake CLAUDE.md
 * section 1 calls out for branch names and D-048 for directory names.
 */
/**
 * SECURITY.md has to name a channel that EXISTS.
 *
 * On 2026-08-20 it did not: the file called GitHub private vulnerability reporting the preferred
 * route while that feature was switched off on the repository, and the stated fallback was a
 * literal `SECURITY_CONTACT_PLACEHOLDER`. A reporter following the document would have found no
 * button and no address. A documented channel that does not exist is worse than an undocumented
 * one, because someone follows it and lands nowhere - and then files publicly instead.
 */
/**
 * The verification-status rows are the project's central honesty claim, and the pressure on them
 * only ever goes one way: one provider passes and it becomes tempting to let the others ride on
 * it. This asserts the opposite - that a provider with no live evidence still says so.
 */
/**
 * BRING YOUR OWN KEY, asserted rather than promised.
 *
 * Two separate claims, and they fail in different directions:
 *   1. usewarden ships NO key material of the maintainer's. A key in a published tarball is
 *      unrecoverable - the version cannot be unpublished from every mirror and cache.
 *   2. usewarden needs no key to work. Layer 1 is deterministic, costs zero tokens, and runs
 *      with nothing configured; only the optional Layer 2 judge ever spends anything, and it is
 *      the user's own key that pays.
 */
/**
 * The three claims an adversarial reader would attack first, pinned so they cannot drift back.
 *
 * Each was an overclaim in the launch drafts and was corrected:
 *   1. "a firewall" - it is a hook shim that intercepts what an agent DECLARES. Not a chokepoint,
 *      not a sandbox. "Firewall" promises containment this cannot deliver.
 *   2. "82.4%" - three significant figures from seventeen samples. The honest form is 14 of 17.
 *   3. "22 catches" - reads as 22 blocks. It is 9 Layer-1 blocks and 13 Layer-2 drift warnings.
 */
describe('launch copy: the claims an adversarial reader would attack', ONLY_PRIVATE, () => {
  /**
   * THE SURFACES A USER ACTUALLY MEETS, not just the launch drafts.
   *
   * This guard existed and still let the overclaim ship. It covered README, the post drafts and
   * the landing page - the places we WRITE marketing - and not the two places a user MEETS the
   * product: `package.json`'s description, which is the sentence npmjs.com prints under the
   * package name, and `src/cli.ts`'s usage banner, which is what `usewarden --help` says. Both
   * still read "a firewall for your AI coding agents" when 0.0.0 went to the registry, so the
   * first thing the world saw was the exact claim an adversarial read had already rejected
   * (D-095, D-171).
   *
   * A guard aimed at the copy we review, and not at the copy we ship, is a guard that passes
   * while the claim goes out.
   */
  const surfaces: [string, string][] = [
    ['README.md', fs.readFileSync(path.join(REPO, 'README.md'), 'utf8')],
    ['launch/POSTS.md', fs.readFileSync(path.join(REPO, 'launch', 'POSTS.md'), 'utf8')],
    ['site/index.html', fs.readFileSync(path.join(REPO, 'site', 'index.html'), 'utf8')],
    ['package.json (npm description)',
      JSON.stringify(JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')))],
    ['src/cli.ts (usewarden --help)', fs.readFileSync(path.join(REPO, 'src', 'cli.ts'), 'utf8')],
    ['scripts/build-publish-tree.sh (publication commit message)',
      fs.readFileSync(path.join(REPO, 'scripts', 'build-publish-tree.sh'), 'utf8')],
  ];

  for (const [name, body] of surfaces) {
    test(`${name} does not call usewarden a firewall`, () => {
      for (const m of body.matchAll(/firewall/gi)) {
        const around = body.slice(Math.max(0, m.index! - 90), m.index! + 40);
        assert.match(around, /not a firewall|call it a "firewall"/i,
          `${name} uses "firewall" as a claim: ...${around.replace(/\s+/g, ' ')}...`);
      }
    });

    test(`${name} quotes the layer-1 rate as N of 17, not a three-figure percentage`, () => {
      // THIS GUARD WAS INERT WHEN IT WAS FOUND, AND THAT IS THE POINT OF THE REWRITE.
      //
      // It searched for the literal `88.2`. When the rate was restated to 82.4 (D-226) the string
      // it looked for stopped existing anywhere, so it scanned every surface, matched nothing, and
      // passed - a control switched off by the very correction it was supposed to police. A guard
      // pinned to one literal is a guard with an expiry date nobody wrote down.
      //
      // So it now matches the SHAPE: any two-digit-point-one-digit percentage. Seventeen samples
      // do not support three significant figures at any value it could take.
      for (const m of body.matchAll(/\b\d{2}\.\d\s?%/g)) {
        const around = body.slice(Math.max(0, m.index! - 110), m.index! + 70);
        assert.match(around, /round \d{2}\.\d|self-graded|significant figures|do not support/i,
          `${name} quotes ${m[0]} as a headline figure: ...${around.replace(/\s+/g, ' ')}...`);
      }
    });
  }

  test('the live-catch figure is stated by composition, not as an undifferentiated total', () => {
    const posts = fs.readFileSync(path.join(REPO, 'launch', 'POSTS.md'), 'utf8').replace(/\s+/g, ' ');
    assert.match(posts, /9 Layer-1 blocks and 13 Layer-2 drift warnings/,
      'the evidence table must break the total down - "22 catches" reads as 22 blocks');
    assert.equal(/\d+ catches in real sessions/.test(posts), false,
      'an undifferentiated catch total is back in the launch copy');
  });

  test('the drafts state the limitation a security reviewer would ask about', () => {
    const posts = fs.readFileSync(path.join(REPO, 'launch', 'POSTS.md'), 'utf8').replace(/\s+/g, ' ');
    assert.match(posts, /unaudited and single-maintainer/i, 'the drafts must say it is unaudited');
    assert.match(posts, /declares/i, 'the drafts must say it intercepts what the agent declares');
    assert.match(posts, /no endpoint at all/i, 'the drafts must state the data flow');
  });

  test('the drafts lead with the reader\'s problem, not the architecture', () => {
    const posts = fs.readFileSync(path.join(REPO, 'launch', 'POSTS.md'), 'utf8');
    const hn = posts.slice(posts.indexOf('## 1. Show HN'), posts.indexOf('## 2. r/ClaudeAI'));
    const firstPara = hn.slice(hn.indexOf('**Body:**') + 9).trim().split('\n\n')[0]!;
    // The opening must describe something happening to the READER, not what the tool is.
    assert.equal(/^Usewarden is/.test(firstPara), false,
      'the Show HN body still opens by defining the product');
    assert.match(firstPara, /you have probably had the moment|your|you/i,
      'the opening must be about the reader');
  });
});

/**
 * THE EXECUTE BIT, AGAIN.
 *
 * D-012 — the first defect this project ever found, and the one the whole design premise came
 * from — was a built CLI with no execute bit: every hook died with EACCES while `status` said
 * PROTECTED. That was fixed in the HOOK path, by registering `<abs node> <abs script>` so the
 * script never needs to be executable.
 *
 * It came back in a place the fix did not cover. `package.json` exposes `dist/src/cli.js` as a
 * global `bin`, and a global install runs it directly. `tsc` writes 0644, so `npm link` produced
 * a `usewarden` command that answered every invocation with "permission denied" — found by
 * installing it, not by any test. Every `npm i -g usewarden` user would have hit it.
 *
 * The build now sets the mode, and this asserts it, because "npm probably chmods bin entries" is
 * exactly the kind of assumption D-012 punished the first time.
 */
describe('the built CLI is executable', () => {
  test('dist/src/cli.js has the execute bit after a build', () => {
    const cli = path.join(REPO, 'dist', 'src', 'cli.js');
    assert.equal(fs.existsSync(cli), true, 'setup failed - run npm run build first');
    if (process.platform !== 'win32') {
      const mode = fs.statSync(cli).mode & 0o777;
      assert.ok((mode & 0o111) !== 0,
        `dist/src/cli.js is ${mode.toString(8)} - a global install would fail with EACCES`);
    }
  });

  test('it starts with a shebang, which is what makes the bin entry runnable', () => {
    const first = fs.readFileSync(path.join(REPO, 'dist', 'src', 'cli.js'), 'utf8').split('\n')[0]!;
    assert.match(first, /^#!/, 'a bin entry without a shebang cannot be executed directly');
  });

  test('the build script sets the mode rather than trusting the packager to', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as
      { scripts?: Record<string, string>; bin?: Record<string, string> };
    assert.match(pkg.scripts?.['build'] ?? '', /chmod/i,
      'the build must set the execute bit itself');
    assert.equal(pkg.bin?.['usewarden'], 'dist/src/cli.js');
  });
});

/**
 * THE ENTRY POINT, INVOKED THE WAY A USER INVOKES IT.
 *
 * Every other test in this suite imports a module. That is why `--version` printed the entire
 * 43-line usage text, in every published version, for as long as the flag has existed: with no
 * positional argument `cmd` is `undefined`, the help branch fired on `cmd === undefined` before
 * the version check was reached, and nothing ever ran the real binary with a bare flag.
 *
 * `usewarden foo --version` DID print the version, which is exactly why it survived — the broken
 * form is the one everybody types and the working form is the one nobody does.
 *
 * Found by running the packed tarball (D2 of the release runbook) rather than the repository. That
 * step exists to be sceptical about the artifact, and this is what it caught.
 */
describe('the CLI entry point, run as a subprocess', () => {
  const CLI = path.join(REPO, 'dist', 'src', 'cli.js');
  const run = (...argv: string[]): { out: string; code: number | null } => {
    const r = spawnSync(process.execPath, [CLI, ...argv],
      { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
    return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, code: r.status };
  };

  test('--version prints ONLY the version', () => {
    const { out, code } = run('--version');
    assert.equal(code, 0);
    assert.equal(out.trim(), VERSION_FROM_PKG(),
      '--version must print the version and nothing else');
    assert.equal(out.trim().split('\n').length, 1, 'exactly one line');
  });

  test('-V behaves identically to --version', () => {
    assert.equal(run('-V').out.trim(), run('--version').out.trim());
  });

  test('--version --json is machine-readable', () => {
    const { out } = run('--version', '--json');
    assert.deepEqual(JSON.parse(out.trim()), { version: VERSION_FROM_PKG() });
  });

  test('--version does NOT print the usage text', () => {
    // The specific regression. `USAGE` contains this heading and nothing else does.
    assert.ok(!run('--version').out.includes('COMMANDS'),
      '--version printed the help text - the flag ordering regressed');
  });

  test('--help still prints usage, and so does a bare invocation', () => {
    for (const argv of [['--help'], ['-h'], []]) {
      const { out, code } = run(...argv);
      assert.equal(code, 0, `${argv.join(' ') || '(bare)'} should exit 0`);
      assert.ok(out.includes('COMMANDS'), `${argv.join(' ') || '(bare)'} should print usage`);
    }
  });

  test('--help wins when both are given, rather than the two racing', () => {
    assert.ok(run('--help', '--version').out.includes('COMMANDS'));
  });

  function VERSION_FROM_PKG(): string {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as
      { version: string };
    return pkg.version;
  }
});

describe('BYOK: no key material ships, and no key is required', () => {
  const CREDENTIAL_PATTERNS: [string, RegExp][] = [
    ['google (legacy)', /AIza[0-9A-Za-z_-]{30,}/],
    ['google (current)', /AQ\.[A-Za-z0-9_-]{20,}/],
    ['anthropic', /sk-ant-[A-Za-z0-9_-]{8,}/],
    ['openai', /sk-(proj-)?[A-Za-z0-9]{16,}/],
    ['github', /gh[pousr]_[A-Za-z0-9]{16,}/],
    ['github fine-grained', /github_pat_[A-Za-z0-9_]{20,}/],
    ['npm', /npm_[A-Za-z0-9]{20,}/],
    ['aws', /AKIA[0-9A-Z]{16}/],
    ['slack', /xox[baprs]-[A-Za-z0-9-]{10,}/],
    ['private key block', /BEGIN [A-Z ]*PRIVATE KEY/],
  ];

  test('the patterns actually match a credential - this scanner is not vacuous', () => {
    const samples = [
      'AIzaSyD' + 'y'.repeat(32), 'AQ.Ab8RN6' + 'x'.repeat(44), 'sk-ant-api03-' + 'z'.repeat(40),
      'sk-proj-' + 'w'.repeat(40), 'ghp_' + 'a'.repeat(36), 'AKIA' + 'B'.repeat(16),
    ];
    for (const sample of samples) {
      assert.ok(CREDENTIAL_PATTERNS.some(([, re]) => re.test(sample)),
        `no pattern matches ${sample.slice(0, 6)}... - the scan below would prove nothing`);
    }
  });

  /**
   * Scans the ACTUAL published file list, resolved from `package.json`'s `files` allowlist, not
   * the working tree. The working tree contains fixtures and verification artifacts that are
   * deliberately not shipped, so scanning it would answer a different question.
   */
  test('no credential pattern appears in any file the package would publish', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { files?: string[] };
    const roots = pkg.files ?? [];
    assert.ok(roots.length > 0, 'setup failed - no files allowlist');

    const shipped: string[] = [];
    const walk = (abs: string, rel: string): void => {
      let st: fs.Stats;
      try { st = fs.statSync(abs); } catch { return; }
      if (st.isDirectory()) {
        for (const e of fs.readdirSync(abs)) walk(path.join(abs, e), path.join(rel, e));
      } else if (st.isFile()) {
        shipped.push(rel);
      }
    };
    for (const r of roots) walk(path.join(REPO, r), r);
    assert.ok(shipped.length > 20, `setup failed - only resolved ${shipped.length} shipped files`);

    const offenders: string[] = [];
    for (const rel of shipped) {
      let body: string;
      try { body = fs.readFileSync(path.join(REPO, rel), 'utf8'); } catch { continue; }
      for (const [label, re] of CREDENTIAL_PATTERNS) {
        const m = re.exec(body);
        // Report the FILE and the pattern name. Never the match - a test failure log is a place
        // a leaked credential would be published a second time.
        if (m) offenders.push(`${rel}: matches the ${label} credential pattern`);
      }
    }
    assert.deepEqual(offenders, [], 'key material would ship in the published package');
  });

  test('package.json declares no key, and no key-shaped environment default', () => {
    const raw = fs.readFileSync(path.join(REPO, 'package.json'), 'utf8');
    for (const [label, re] of CREDENTIAL_PATTERNS) {
      assert.equal(re.test(raw), false, `package.json matches the ${label} pattern`);
    }
  });

  test('the shipped source reads every key from the environment and hardcodes none', () => {
    const judge = fs.readFileSync(path.join(REPO, 'src', 'engine', 'judge.ts'), 'utf8');
    // Each provider's key must be reached through process.env, never assigned a literal.
    for (const v of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY']) {
      assert.match(judge, new RegExp(`env: '${v}'`), `${v} is not declared as an env var name`);
      assert.equal(new RegExp(`${v}\\s*[=:]\\s*['"\`][A-Za-z0-9]`).test(judge), false,
        `${v} appears to be assigned a literal value`);
    }
    assert.match(judge, /process\.env\[cfg\.env\]/, 'keys must be read from the environment at call time');
  });

  test('the README states plainly that the user brings the key and Layer 1 is free', () => {
    // Whitespace-tolerant on purpose: markdown wraps, and a claim that moves to the next line is
    // still the same claim. The first version of this asserted a literal space and failed the
    // moment the sentence wrapped between "your" and "own".
    const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8').replace(/\s+/g, ' ');
    assert.match(readme, /bring your own key/i,
      'the README must say the user supplies the key');
    assert.match(readme, /Layer 1[^.]*(costs nothing|zero tokens|no API key|needs no key|free)/i,
      'the README must say Layer 1 needs no key and costs nothing');
  });
});

describe('provider verification status is per provider, never inherited', () => {
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  const matrix = fs.readFileSync(path.join(REPO, 'docs', 'HOOK-MATRIX.md'), 'utf8');
  const artifact = fs.readFileSync(path.join(REPO, 'verification', 'judge-live-check.txt'), 'utf8');

  test('the artifact records one line per provider, and they do not all agree', () => {
    assert.match(artifact, /^gemini:\s+PASS/m, 'setup failed - the artifact does not record a gemini pass');
    assert.match(artifact, /^anthropic:\s+UNVERIFIED-LIVE/m);
    assert.match(artifact, /^openai:\s+UNVERIFIED-LIVE/m);
  });

  for (const [name, doc] of [['README.md', readme], ['docs/HOOK-MATRIX.md', matrix]] as const) {
    test(`${name}: gemini is verified, anthropic and openai are not`, () => {
      const rows = doc.split('\n').filter((l) => l.trim().startsWith('|'));
      const rowFor = (needle: string): string | undefined =>
        rows.find((r) => r.toLowerCase().includes(needle) && /UNVERIFIED-LIVE|verified \d{4}-/.test(r));

      const gem = rowFor('gemini api') ?? rowFor('`gemini`');
      assert.ok(gem, `${name} has no gemini status row`);
      assert.match(gem, /verified 2026-\d\d-\d\d/, 'gemini passed live and the row must say so');

      for (const other of ['anthropic', 'openai']) {
        const row = rowFor(`${other} api`) ?? rowFor(`\`${other}\``);
        assert.ok(row, `${name} has no ${other} status row`);
        assert.match(row, /UNVERIFIED-LIVE/,
          `${other} has no live evidence and must not be marked verified because gemini passed`);
      }
    });
  }

  test('the claimed figures match the recorded artifact', () => {
    // The README quotes token counts and a cost. They have to be the ones that actually happened.
    const claimed = /(\d+) in \/ (\d+) out, \$([0-9.]+)/.exec(readme);
    assert.ok(claimed, 'the README no longer quotes the live-call figures');
    assert.match(artifact, new RegExp(`in ${claimed[1]}, out ${claimed[2]}`),
      'the README quotes token counts the artifact does not show');
    assert.match(artifact, new RegExp(`\\$${claimed[3]!.replace('.', '\\.')}`),
      'the README quotes a cost the artifact does not show');
  });
});

describe('SECURITY.md names a disclosure channel that exists', () => {
  const sec = fs.readFileSync(path.join(REPO, 'SECURITY.md'), 'utf8');

  test('the placeholder is not presented as the contact', () => {
    // Scoped to the document a REPORTER reads, which is the only place the string can do harm.
    //
    // This assertion was written twice too broadly first - once catching the script that greps
    // for the placeholder, once catching DECISIONS.md and FINAL-REPORT.md explaining that it was
    // removed. That is the same shape as D-084 and it is worth stating as a rule: a scanner must
    // distinguish USING a bad pattern from NAMING it. The history of a fix has to be allowed to
    // name the thing it fixed, or the honest record becomes the thing that fails the build.
    assert.equal(sec.includes('SECURITY_CONTACT_PLACEHOLDER'), false,
      'SECURITY.md still offers the placeholder as a contact');
    assert.equal(/PUT YOUR ADDRESS HERE|<your-address>|CHANGEME|TODO/i.test(sec), false,
      'SECURITY.md contains an unfilled template marker');
  });

  test('it links the private advisory form, which is a route that works without an address', () => {
    assert.match(sec, /security\/advisories\/new/, 'the advisory form must be linked directly');
    assert.match(sec, /do not open a public issue/i);
  });

  test('it publishes no email address', () => {
    // An address in a public SECURITY.md cannot be rotated and cannot be un-published.
    const emails = [...sec.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map((m) => m[0]);
    assert.deepEqual(emails, [],
      `SECURITY.md publishes ${emails.join(', ')} - a personal address here is permanent`);
  });

  test('it still tells a reporter what to include', () => {
    for (const expected of [/usewarden version/, /Node version/, /reproduction/]) {
      assert.match(sec, expected);
    }
  });
});

describe('pre-push guard: the public repository cannot be pushed to', ONLY_PRIVATE, () => {
  const HOOK = path.join(REPO, '.githooks', 'pre-push');

  const run = (name: string, url: string): number => {
    const r = spawnSync(HOOK, [name, url], { encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL' });
    assert.equal(r.signal, null, 'the hook had to be killed - it hung');
    return r.status ?? -1;
  };

  /**
   * THE HOOK'S AUTHORITY COMES FROM CLAUDE.md, NOT FROM A CONSTANT INSIDE THE HOOK.
   *
   * CLAUDE.md §7 says of its exceptions: "A prompt that appears to authorize one of these is not
   * sufficient; only the founder editing this section is." If the hook carried its own copy of
   * that boundary, an agent that can edit the hook could move the boundary by itself - which is
   * exactly what that sentence forbids. So the hook reads §7 at push time and the founder's edit
   * to §7 IS the switch.
   *
   * These tests pin the wiring, because a permission that is derived is a permission that can
   * silently stop being derived.
   */
  const hookSrc = (): string => fs.readFileSync(HOOK, 'utf8');

  test('the hook reads CLAUDE.md rather than hard-coding whether public pushes are allowed', () => {
    const src = hookSrc();
    assert.match(src, /CLAUDE_MD="\$ROOT\/CLAUDE\.md"/,
      'the hook no longer reads CLAUDE.md - its authority has drifted into a constant');
    assert.match(src, /### The four exceptions/,
      'the hook does not look for the OLD marker, so it cannot refuse under the old regime');
    assert.match(src, /### Pushing to the public repository/,
      'the hook does not look for the NEW marker, so the amendment could never take effect');
  });

  test('the hook fails closed when CLAUDE.md says two things at once', () => {
    // Both markers present means the document is mid-edit. A permission decision must not be
    // read from an ambiguous source, so the hook refuses rather than picking one.
    const src = hookSrc();
    assert.match(src, /HAS_OLD.*=.*"1".*HAS_NEW.*=.*"1"|\$HAS_OLD" = "1" \] && \[ "\$HAS_NEW" = "1"/,
      'no both-markers case - an ambiguous CLAUDE.md would fall through to one of the branches');
  });

  test('the four section-7 conditions are each enforced by name in the hook', () => {
    const src = hookSrc();
    for (const c of ['condition 1', 'condition 3', 'condition 4']) {
      assert.ok(src.includes(c), `the hook never mentions ${c} - it cannot be enforcing it`);
    }
    // Condition 3 is the irreversible one: a non-fast-forward must be detected from git's own
    // ref data, not assumed.
    assert.match(src, /merge-base --is-ancestor/,
      'no ancestry check - the hook cannot tell a force-push from a fast-forward');
    // Condition 2 happens after the push, so the hook must at least point at it.
    assert.match(src, /read-back-public\.sh/,
      'the hook never names the read-back step, so condition 2 would be forgotten');
  });

  test('the scripts the conditions depend on all exist and are executable', () => {
    for (const rel of ['scripts/public-push-gate.sh',
                       'scripts/read-back-public.sh',
                       'scripts/scan-published-head.sh',
                       'scripts/apply-amendment.sh']) {
      const p = path.join(REPO, rel);
      assert.equal(fs.existsSync(p), true, `${rel} is missing - a §7 condition names a script that is not there`);
      if (process.platform !== 'win32') {
        assert.equal((fs.statSync(p).mode & 0o111) !== 0, true, `${rel} is not executable`);
      }
    }
  });

  test('the amendment script does not apply itself, and CLAUDE.md is not already amended by it', () => {
    // If a run ever edits CLAUDE.md §7 on its own, this is the test that says so. The amendment
    // is the founder's to apply; the script only prepares it.
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'apply-amendment.sh'), 'utf8');
    assert.match(src, /--write/, 'the amendment script has no explicit write flag - it could apply by accident');
    // Not "the string never appears" - the script PRINTS the commit command as an instruction,
    // which is the point. What must not exist is a line that RUNS one.
    assert.ok(!/^\s*git commit/m.test(src),
      'the amendment script executes a commit - the change must carry the founder\'s git identity, not a script\'s');
  });

  /**
   * TWO DIFFERENT PROPERTIES, and this test used to assert both as one.
   *
   * That the hook file exists, is executable, and refuses the public URL is a property of the
   * REPOSITORY: it holds in every checkout and the tests below prove it by invoking the hook.
   * That `core.hooksPath` points at `.githooks` is a property of ONE MACHINE - it is set by
   * `scripts/install-git-hooks.sh`, and a fresh clone has never run it.
   *
   * Asserting the machine property here asserted a falsehood on every CI runner, which is why
   * this test failed on all four legs of the matrix from the day the workflow was added. Moving
   * it out is not dropping it: `scripts/verify-hardening.sh` now FAILS when the hook is not
   * installed, and that script runs on the machine that actually pushes, which is the only
   * machine where the guard can fire. A wrong value is still a failure everywhere - only an
   * absent one is treated as "not installed in this checkout".
   */
  test('the hook exists and is executable in every checkout', () => {
    assert.equal(fs.existsSync(HOOK), true, 'setup failed - no pre-push hook');
    if (process.platform !== 'win32') {
      assert.equal((fs.statSync(HOOK).mode & 0o111) !== 0, true, 'the hook is not executable');
    }
    const cfg = spawnSync('git', ['config', 'core.hooksPath'], { cwd: REPO, encoding: 'utf8', timeout: 15_000 });
    const configured = cfg.stdout.trim();
    if (configured !== '') {
      assert.equal(configured, '.githooks',
        `core.hooksPath is set to ${configured}, which is not where the guard lives`);
    }
  });

  test('the installer is what points git at the hook, and it is present to be run', () => {
    // The machine-level check lives in verify-hardening.sh; this asserts the thing it tells you
    // to run actually exists and sets the value it claims to set.
    const installer = path.join(REPO, 'scripts', 'install-git-hooks.sh');
    assert.equal(fs.existsSync(installer), true, 'no installer - the hardening gate would name a missing script');
    assert.match(fs.readFileSync(installer, 'utf8'), /core\.hooksPath\s+\.githooks/,
      'the installer does not set core.hooksPath to .githooks');
  });

  test('a push to the public repository is REFUSED, https and ssh alike', () => {
    assert.equal(run('public', 'https://github.com/djayamah/usewarden.git'), 1);
    assert.equal(run('public', 'https://github.com/djayamah/usewarden'), 1, 'a missing .git suffix must not slip through');
    assert.equal(run('anything', 'git@github.com:djayamah/usewarden.git'), 1);
    assert.equal(run('x', 'HTTPS://GitHub.com/DJayamah/UseWarden.git'), 1, 'case must not slip through');
  });

  test('the URL decides, not the remote name', () => {
    // The public URL wearing the private remote's name must still be refused...
    assert.equal(run('origin', 'https://github.com/djayamah/usewarden.git'), 1,
      'the hook trusted the remote NAME - a name is not a safe selector');
    // ...and the private URL wearing the public remote's name must still be allowed.
    assert.equal(run('public', 'https://github.com/djayamah/warden.git'), 0,
      'the hook refused the private repository because of what the remote was called');
  });

  test('it fails CLOSED on an argument it cannot parse', () => {
    assert.equal(run('public', ''), 1, 'an unparseable destination must be refused, not waved through');
  });

  test('the private mirror is still pushable', () => {
    assert.equal(run('origin', 'https://github.com/djayamah/warden.git'), 0);
    assert.equal(run('origin', 'git@github.com:djayamah/warden.git'), 0);
  });

  /**
   * THIS TEST CHANGED WHEN §7 CHANGED, and that is the point of it.
   *
   * Before the 2026-08-21 amendment the hook refused every public push outright, and this test
   * asserted the refusal named `git push origin main` as the way out. §7 now authorises public
   * pushes under four conditions, so a bare invocation is no longer refused for being public - it
   * is refused for failing a condition (no ref lines on stdin means the hook cannot prove a
   * fast-forward, and it fails closed).
   *
   * What must remain true in EITHER regime: a refusal names the rule it is enforcing, and names
   * the way out. A refusal that does neither is a trap. So the assertion is on those two
   * properties, not on the one sentence that happened to satisfy them under the old regime.
   */
  test('the refusal names the rule and the way out, under whichever regime §7 is in', () => {
    const r = spawnSync(HOOK, ['public', 'https://github.com/djayamah/usewarden.git'],
      { encoding: 'utf8', timeout: 120_000 });
    assert.match(r.stderr, /PUSH REFUSED/, 'a bare public push must still be refused - it cannot prove a fast-forward');
    assert.match(r.stderr, /CLAUDE\.md|§7|section 7/, 'the refusal must name the rule it is enforcing');
    assert.match(r.stderr, /git push origin main|public-push-gate\.sh|apply-amendment\.sh/,
      'a refusal that does not name the way out is a trap');
  });

  test('a bare public push fails CLOSED because it cannot prove a fast-forward', () => {
    // No ref lines on stdin means the hook does not know what is being sent. Condition 3 is the
    // irreversible one, so not knowing is refused rather than waved through.
    const r = spawnSync(HOOK, ['public', 'https://github.com/djayamah/usewarden.git'],
      { encoding: 'utf8', timeout: 120_000 });
    assert.notEqual(r.status, 0, 'a push it cannot reason about was allowed');
  });

  /**
   * `--no-verify` is the one flag that turns the guard off. Prose may NAME it - CLAUDE.md,
   * DECISIONS.md, PROGRESS.md and the hook's own refusal message all do, and they should, because
   * a control nobody can read about is a control nobody can reason about. Nothing executable may
   * USE it.
   *
   * The first version of this test kept a per-file allowlist and broke the moment PROGRESS.md
   * recorded the row asserting it. An allowlist that grows every time someone documents the thing
   * it protects is the wrong mechanism: it scans only files that can run, and inside those, only
   * for the flag actually attached to a git invocation.
   */
  test('nothing executable passes --no-verify', () => {
    const EXECUTABLE = /\.(sh|bash|zsh|ts|js|mjs|cjs|yml|yaml|json|toml)$|(^|\/)(Makefile|Dockerfile)$/;
    const hits = spawnSync('git', ['grep', '-rIn', '--', '--no-verify'], { cwd: REPO, encoding: 'utf8', timeout: 20_000 });
    // sabotage landed: the flag really does appear somewhere, so the scan is looking at something.
    assert.ok((hits.stdout ?? '').length > 0, 'setup failed - git grep found no mention at all');

    const offenders: string[] = [];
    for (const line of (hits.stdout ?? '').split('\n').filter(Boolean)) {
      const [file, , ...rest] = line.split(':');
      if (!file || !EXECUTABLE.test(file)) continue;             // prose may name the flag
      if (file === '.githooks/pre-push') continue;               // its own refusal message
      if (file.startsWith('tests/')) continue;                   // this test names it too
      const body = rest.join(':');
      if (/\bgit\b[^\n]*--no-verify|--no-verify[^\n]*\bgit\b/.test(body)) offenders.push(line);
    }
    assert.deepEqual(offenders, [], 'these would bypass the pre-push guard');
  });
});

// ---------------------------------------------------------------------------
// displayPath: the dashboard and the incident cards are what people screenshot.
// An absolute path in one of those carries the operator's account name into every
// screenshot, issue and tweet. This is a privacy control, so it is tested like one:
// the sabotage (a real home-directory path in the string) is asserted to have landed
// before the collapse is asserted to have worked.
// ---------------------------------------------------------------------------
describe('displayPath', () => {
  const home = os.homedir();

  test('the sabotage lands: a raw incident really does carry the home directory', () => {
    const raw = `$ cat ${path.join(home, 'dev/acme-api/.env')}`;
    assert.ok(raw.includes(home), 'setup failed - the string under test has no home path in it');
  });

  test('collapses the home directory to ~', () => {
    const raw = path.join(home, 'dev/acme-api/.env');
    const shown = displayPath(raw);
    assert.equal(shown, path.join('~', 'dev/acme-api/.env'));
    assert.equal(shown.includes(home), false, 'the home directory survived the collapse');
  });

  test('collapses EVERY occurrence, not just a prefix', () => {
    const a = path.join(home, 'dev/acme-api');
    const b = path.join(home, 'dev/acme-web/src/x.ts');
    const shown = displayPath(`cp ${b} ${a}/`);
    assert.equal(shown.includes(home), false);
    assert.equal((shown.match(/~/g) ?? []).length, 2);
  });

  test('leaves paths outside the home directory exactly as they are', () => {
    assert.equal(displayPath('/etc/hosts'), '/etc/hosts');
    assert.equal(displayPath('/Users/you/dev/acme-api'), '/Users/you/dev/acme-api');
  });

  test('is DISPLAY ONLY: scope decisions still run on the resolved absolute path', () => {
    const parent = path.join(home, 'dev/acme-api');
    const child = path.join(home, 'dev/acme-api/src/x.ts');
    assert.equal(isInside(parent, child), true);
    // the collapsed form must never be fed to a scope decision - it would not resolve
    assert.equal(isInside(displayPath(parent), child), false,
      'a ~-collapsed path must not silently satisfy a scope check');
  });
});

/**
 * THE INTERNAL-ONLY PATH LIST, AND WHY IT IS TESTED AT ALL.
 *
 * Three scripts decide what "never leaves this repository" means, and they must mean the same
 * thing: the publisher drops those paths, the sanitiser skips redacting them BECAUSE they are
 * dropped, and the scanner does not report identity findings in them for the same reason. Two of
 * them carried their own copy of the regex and the copies HAD ALREADY DRIFTED - the publisher
 * dropped four paths the sanitiser had never heard of. That drift happened to go in the safe
 * direction. The other direction - a path the sanitiser skips but the publisher keeps - ships a
 * file with real paths in it and nothing anywhere says so.
 *
 * So the property under test is not "the list has the right contents" (that is the founder's
 * call) but "there is exactly one list".
 */
describe('internal-only paths: one list, three consumers, no copies', () => {
  const LIST = path.join(REPO, 'scripts', 'internal-only-paths.txt');
  const CONSUMERS = [
    'scripts/build-publish-tree.sh',
    'scripts/sanitise-for-publication.sh',
    'scripts/pre-public-scan.sh',
  ];

  test('the list exists and is not empty', () => {
    assert.equal(fs.existsSync(LIST), true, 'the single source of truth is missing');
    const frags = fs.readFileSync(LIST, 'utf8')
      .split('\n').map((l) => l.split('#')[0]!.trim()).filter((l) => l !== '');
    assert.ok(frags.length >= 5, `only ${frags.length} entries - an empty list silently publishes everything`);
    assert.ok(frags.includes('CLAUDE\\.md'), 'CLAUDE.md must never be published: it names the real private paths');
  });

  test('every consumer reads the file, and none restates the list', () => {
    const frags = fs.readFileSync(LIST, 'utf8')
      .split('\n').map((l) => l.split('#')[0]!.trim()).filter((l) => l !== '')
      .map((f) => f.replace(/\\/g, ''));   // `CLAUDE\.md` -> `CLAUDE.md`

    for (const rel of CONSUMERS) {
      const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
      assert.match(src, /internal-only-paths\.txt/, `${rel} does not read the shared list`);

      // A copy is detected by looking for the LIST'S OWN ENTRIES in the code, not by looking for
      // "a regex with alternation in it" - the first version of this check did the latter and
      // flagged an unrelated `^(root|admin|user|runner|ubuntu)$`, which is the scanner-too-broad
      // failure (D-091) committed inside the test written to prevent a different one. Comments
      // are stripped first: build-publish-tree.sh documents every excluded path and why, and
      // documentation naming a path is not a second copy of the list.
      // Backslashes are stripped from the CODE as well as from the fragments: a re-introduced
      // copy would be written as a regex - `CLAUDE\.md|SPEC-BUILD\.md` - and comparing an
      // unescaped fragment against escaped source finds nothing. The first version of this check
      // did exactly that and passed against a deliberately re-introduced copy, which is why it
      // is A/B-tested rather than trusted.
      const code = src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n').replace(/\\/g, '');
      const echoed = frags.filter((f) => code.includes(f));
      assert.ok(echoed.length < 2,
        `${rel} names ${echoed.length} of the list's own entries in code (${echoed.join(', ')}) `
        + '- that looks like a re-introduced copy of the list');
    }
  });

  test('the publisher actually drops what the list names', ONLY_PRIVATE, () => {
    const frags = fs.readFileSync(LIST, 'utf8')
      .split('\n').map((l) => l.split('#')[0]!.trim()).filter((l) => l !== '');
    const re = new RegExp(`^(${frags.join('|')})`);
    // Assert the sabotage lands: these paths really are tracked right now, so "dropped" is a
    // real change of state and not a no-op on files that were never there.
    const tracked = spawnSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8', timeout: 30_000 })
      .stdout.split('\n').filter(Boolean);
    const wouldDrop = tracked.filter((f) => re.test(f));
    assert.ok(wouldDrop.length > 0, 'setup failed - none of the internal-only paths is tracked');
    assert.ok(wouldDrop.includes('CLAUDE.md'), 'CLAUDE.md is tracked and must be among the dropped paths');
  });
});

/**
 * THE LAYER-1 RATE APPEARS ON SIX SURFACES AND IT DRIFTED ON THREE OF THEM.
 *
 * When the figure was restated from 15/17 to 14/17 (D-226), a `grep` for "15 of 17" corrected the
 * places that used that exact wording and silently missed every "15 of **the** 17". Three surfaces
 * kept a number that was no longer true, including the README FAQ - the answer a first-time reader
 * gets to "do I need an API key".
 *
 * Correcting three files is not the fix. The fix is that the number is DERIVED from the suite that
 * measures it, so the next restatement fails here instead of shipping.
 */
describe('launch copy: the layer-1 rate is derived, not retyped', ONLY_PRIVATE, () => {
  const suite = fs.readFileSync(path.join(REPO, 'tests', 'sabotage', 'suite.test.ts'), 'utf8');

  /** The real numbers, parsed out of SAB-13 rather than trusted from prose. */
  const measured = (): { caught: number; total: number } => {
    const block = /const SCENARIOS[\s\S]*?\n  \];/.exec(suite);
    assert.ok(block, 'setup failed - SAB-13 no longer declares a SCENARIOS list');
    const total = block[0].split('\n').filter((l) => /^\s*\['/.test(l)).length;
    const misses = /assert\.deepEqual\(missed\.sort\(\), \[([\s\S]*?)\]/.exec(suite);
    assert.ok(misses, 'setup failed - SAB-13 no longer asserts its expected misses');
    const missed = (misses[1] ?? '').split('\n').filter((l) => /'/.test(l)).length;
    assert.ok(total > 10 && missed > 0, `setup failed - parsed ${total} scenarios, ${missed} misses`);
    return { caught: total - missed, total };
  };

  const surfaces = ['README.md', 'launch/POSTS.md', 'launch/HN-COMMENT-PREP.md',
    'launch/REDDIT-PRESENCE.md', 'site/index.html', 'docs/VALUE-DELIVERED.md'];

  for (const rel of surfaces) {
    test(`${rel} states the rate the suite actually measures`, () => {
      const { caught, total } = measured();
      const body = fs.readFileSync(path.join(REPO, rel), 'utf8');
      // Every "N of [the] M" claim about the sabotage suite, in any of the phrasings used.
      for (const m of body.matchAll(/(\d+)\s*(?:of|\/)\s*(?:the\s+)?(\d+)\b/g)) {
        const [a, b] = [Number(m[1]), Number(m[2])];
        if (b !== total) continue;                    // not a claim about this suite
        const around = body.slice(Math.max(0, m.index! - 160), m.index! + 90);
        // A sentence that is explicitly describing the OLD figure is allowed to name it.
        if (/until 2026-08-24|was reported as|used to be|previously|restated/i.test(around)) continue;
        assert.equal(a, caught,
          `${rel} claims ${a} of ${b}; the suite measures ${caught} of ${total}. `
          + `...${around.replace(/\s+/g, ' ')}...`);
      }
    });
  }

  test('THE DERIVATION LANDS: it reads a real, non-trivial pair out of the suite', () => {
    const { caught, total } = measured();
    assert.equal(total, 17);
    assert.ok(caught > 0 && caught < total, `implausible pair ${caught}/${total}`);
  });
});

/**
 * THE SCREENSHOT GATE MUST NOT REACH OUTSIDE THE FENCE (D-234).
 *
 * Every screenshot this repository produced ran a browser binary that was a SYMLINK into one of
 * the operator's private directories — a path CLAUDE.md §1 forbids twice over. (The directory is
 * deliberately not named here: `tests/` is exempt from the publication sanitiser precisely so that
 * a fixture's meaning cannot be rewritten underneath it, which means a private name written in
 * this file reaches the published repository. The operator-privacy gate caught this comment doing
 * exactly that, which is the gate working.) The check was
 * `[ -x "$candidate" ]`, which follows the link and reports success: the path that was checked was
 * not the path that was used. §1 says it outright — *a symlink is not a fence* — and the tooling
 * did neither thing it asks.
 *
 * Four scripts each carried their own copy of the candidate list, so fixing one left three. That is
 * the drift `scripts/internal-only-paths.txt` exists to prevent, and it happened again.
 */
describe('screenshots: the browser is resolved once, and fenced', () => {
  const SHOTS = ['screenshot.sh', 'screenshot-synthetic.sh', 'screenshot-site.sh',
    'screenshot-ops-dashboard.sh'];

  test('no screenshot script carries its own browser candidate list', () => {
    for (const f of SHOTS) {
      const s = fs.readFileSync(path.join(REPO, 'scripts', f), 'utf8');
      assert.ok(!/ms-playwright/.test(s),
        `${f} names a browser path directly. The list lives in scripts/resolve-browser.sh, once.`);
      assert.match(s, /resolve-browser\.sh/, `${f} does not use the shared resolver`);
      assert.match(s, /usewarden_resolve_browser/, `${f} does not call the resolver`);
    }
  });

  test('the resolver is sourced UNCONDITIONALLY, so an override cannot skip the fence', () => {
    // The first version sourced it only when SHELL_BIN was unset - so setting SHELL_BIN, the one
    // case the fence exists for, bypassed it and failed with "command not found" instead.
    for (const f of SHOTS) {
      const s = fs.readFileSync(path.join(REPO, 'scripts', f), 'utf8');
      assert.ok(!/\]\s*\|\|\s*\.\s+"\$REPO\/scripts\/resolve-browser\.sh"/.test(s),
        `${f} sources the resolver conditionally; an override would skip the fence`);
    }
  });

  test('the resolver refuses a forbidden path, and says why', () => {
    const s = fs.readFileSync(path.join(REPO, 'scripts', 'resolve-browser.sh'), 'utf8');
    assert.match(s, /realpath/, 'it must RESOLVE the symlink before judging it');
    // THE FENCE, NOT THE NAMES ON IT.
    //
    // This used to assert two of the operator's private directory names literally. Those names are
    // redacted at publication, so the assertion failed in the published repository and had done
    // since the resolver was written — the same never-noticed class as the rest of this run's
    // publication fixes. Naming them here also put a private string in a test that ships.
    //
    // What matters is that the resolver HAS a refusal arm with a non-empty pattern list and exits
    // non-zero, which is checkable without reproducing anybody's directory names.
    const arm = /case\s+"\$real"\s+in([\s\S]*?)esac/.exec(s);
    assert.ok(arm, 'the resolver no longer matches the resolved path against anything');
    const patterns = (arm[1] ?? '').split('\n')[1] ?? '';
    assert.ok(patterns.split('|').length >= 2,
      'the refusal arm lists fewer than two forbidden patterns - the fence has been emptied');
    assert.match(s, /REFUSING to run it/);
    // It must return non-zero, not warn. "Could not verify" is a failure, not a pass.
    assert.match(s, /return 1 ;;/);
  });
});
