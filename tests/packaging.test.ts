import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { buildPayload, endpoint, isSafeLabel, record, telemetryEnabled } from '../src/telemetry.js';
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
    for (const bad of ['src', 'tests', 'fixtures', 'verification', '.usewarden-live', 'scripts']) {
      assert.equal(files.includes(bad), false, `"${bad}" must not be published`);
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

  test('DO_NOT_TRACK=1 overrides an explicit opt-in', () => {
    store.setMeta('telemetry', 'on');
    assert.equal(telemetryEnabled(store), true);
    process.env['DO_NOT_TRACK'] = '1';
    assert.equal(telemetryEnabled(store), false);
  });

  test('USEWARDEN_TELEMETRY=0 overrides an explicit opt-in', () => {
    store.setMeta('telemetry', 'on');
    process.env['USEWARDEN_TELEMETRY'] = '0';
    assert.equal(telemetryEnabled(store), false);
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
