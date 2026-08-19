import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Store } from '../src/store.js';
import {
  applyInit, canonicalJson, extractUsewardenEntries, integrityHash, isUsewardenEntry,
  mergeEntries, nodePath, planInit, removeEntries, restoreConfigs, uninstall, usewardenScriptPath,
} from '../src/install/installer.js';
import { readJsonFile, serialize, previewDiff, detectIndent } from '../src/install/jsonfile.js';
import { buildStatus } from '../src/status.js';
import { sandbox, gitInit, type Sandbox } from './helpers.js';
import { sha256 } from '../src/util.js';

let sb: Sandbox;
let claudeSettings: string;

const PRE_EXISTING = `{
    "model": "opus",
    "env": {
        "FOO": "bar"
    },
    "hooks": {
        "Stop": [
            {
                "hooks": [
                    {
                        "type": "command",
                        "command": "/usr/bin/true"
                    }
                ]
            }
        ]
    },
    "statusLine": {
        "type": "command",
        "command": "/bin/echo hi"
    }
}
`;

beforeEach(() => {
  sb = sandbox();
  fs.mkdirSync(path.join(sb.agentHome, '.claude'), { recursive: true });
  claudeSettings = path.join(sb.agentHome, '.claude', 'settings.json');
  fs.writeFileSync(claudeSettings, PRE_EXISTING);
  gitInit(sb.repo);
});
afterEach(() => { sb.cleanup(); });

function freshStore(): Store { return new Store(path.join(sb.usewardenHome, 'usewarden.db')); }

describe('json file editing (least privilege)', () => {
  test('detects indentation rather than imposing one', () => {
    assert.equal(detectIndent(PRE_EXISTING), '    ');
    assert.equal(detectIndent('{\n  "a": 1\n}\n'), '  ');
    assert.equal(detectIndent('{\n\t"a": 1\n}\n'), '\t');
  });

  test('a no-op round trip is byte-identical', () => {
    const f = readJsonFile(claudeSettings);
    assert.equal(serialize(f), f.raw);
  });

  test('G3: unrelated keys, key order, indent and trailing newline all survive', () => {
    const f = readJsonFile(claudeSettings);
    mergeEntries(f, 'claude', '/abs/usewarden');
    const after = serialize(f);
    const before = JSON.parse(PRE_EXISTING);
    const parsed = JSON.parse(after);
    assert.deepEqual(parsed.model, before.model);
    assert.deepEqual(parsed.env, before.env);
    assert.deepEqual(parsed.statusLine, before.statusLine);
    assert.deepEqual(parsed.hooks.Stop, before.hooks.Stop, 'a foreign hook must be untouched');
    assert.deepEqual(Object.keys(parsed), Object.keys(before), 'key order must not change');
    assert.match(after, /\n    "model"/, 'indentation must stay 4 spaces');
    assert.ok(after.endsWith('\n'));
  });

  test('refuses to overwrite a non-object where the hooks container belongs', () => {
    fs.writeFileSync(claudeSettings, '{"hooks": "surprise"}\n');
    const f = readJsonFile(claudeSettings);
    assert.throws(() => mergeEntries(f, 'claude', '/abs/usewarden'), /not an object/);
  });

  test('previewDiff shows adds and removes', () => {
    const d = previewDiff('a\nb\nc\n', 'a\nx\nc\n', 'f');
    assert.match(d, /^- b$/m);
    assert.match(d, /^\+ x$/m);
  });
});

describe('hook entries', () => {
  test('T-04: every registered command is <abs node> <abs script> with a FIXED argv', () => {
    const f = readJsonFile(claudeSettings);
    const script = '/opt/usewarden/bin/usewarden.js';
    mergeEntries(f, 'claude', script);
    const hooks = f.value['hooks'] as Record<string, unknown[]>;
    let seen = 0;
    for (const [, entries] of Object.entries(hooks)) {
      for (const entry of entries) {
        const inner = (entry as Record<string, unknown>)['hooks'] as Record<string, unknown>[] | undefined;
        if (!inner) continue;
        for (const h of inner) {
          if (h['_usewarden'] !== true) continue; // the fixture's foreign Stop hook stays foreign
          seen++;
          assert.equal(h['command'], nodePath(), 'command must be the absolute node binary');
          assert.ok(path.isAbsolute(String(h['command'])));
          const args = h['args'] as unknown[];
          assert.equal(args[0], script, 'argv[0] must be the absolute usewarden script');
          assert.equal(args[1], 'hook');
          assert.equal(args[2], 'claude');
          assert.match(String(args[3]), /^[a-z_]+$/);
          assert.equal(args.length, 4, 'argv must be fixed length - nothing can be appended');
        }
      }
    }
    assert.ok(seen >= 6, 'usewarden should register several events');
    // No shell metacharacter anywhere in usewarden's own subtree.
    fs.writeFileSync(claudeSettings, serialize(f));
    const mine = JSON.stringify(extractUsewardenEntries(claudeSettings, 'claude') ?? {});
    assert.equal(/[;&|`$><]/.test(mine), false, 'no shell metacharacters in usewarden entries');
  });

  test('registering twice does not duplicate entries', () => {
    const f = readJsonFile(claudeSettings);
    mergeEntries(f, 'claude', '/abs/usewarden');
    const once = serialize(f);
    mergeEntries(f, 'claude', '/abs/usewarden');
    assert.equal(serialize(f), once);
  });

  test('removeEntries leaves foreign entries and restores the original bytes', () => {
    const f = readJsonFile(claudeSettings);
    mergeEntries(f, 'claude', '/abs/usewarden');
    removeEntries(f, 'claude');
    assert.equal(serialize(f), PRE_EXISTING);
  });

  test('isUsewardenEntry recognises the tag at either level', () => {
    assert.equal(isUsewardenEntry({ _usewarden: true }), true);
    assert.equal(isUsewardenEntry({ hooks: [{ _usewarden: true }] }), true);
    assert.equal(isUsewardenEntry({ hooks: [{ type: 'command' }] }), false);
  });

  test('canonicalJson is order-insensitive so key shuffling is not a false TAMPERED', () => {
    assert.equal(canonicalJson({ a: 1, b: [2, { d: 4, c: 3 }] }), canonicalJson({ b: [2, { c: 3, d: 4 }], a: 1 }));
    assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: 2 }));
  });
});

describe('init / uninstall / restore', () => {
  test('G1+G2: backup and diff exist on disk, and G4: init is idempotent', () => {
    const store = freshStore();
    const changes = planInit();
    assert.equal(changes.length, 1);
    assert.equal(changes[0]!.agent, 'claude');
    assert.equal(changes[0]!.changed, true);

    const res = applyInit(changes, store);
    assert.equal(res.applied, true);
    assert.ok(res.backupDir);
    const files = fs.readdirSync(res.backupDir!);
    assert.ok(files.includes('manifest.json'));
    assert.equal(files.some((f) => f.endsWith('.diff')), true, 'G2: diff archived beside backup');
    const backedUp = files.find((f) => !f.endsWith('.diff') && f !== 'manifest.json')!;
    assert.equal(fs.readFileSync(path.join(res.backupDir!, backedUp), 'utf8'), PRE_EXISTING,
      'G1: backup holds the PRE-init bytes');

    const second = planInit();
    assert.equal(second[0]!.changed, false, 'G4: second init has nothing to write');
    store.close();
  });

  test('G5: uninstall restores a config that never HAD a hooks block byte-identically', () => {
    // Regression from the clean-machine simulation: usewarden created `"hooks": {}` and uninstall
    // left the empty shell behind, one key short of byte-identical. A unit fixture that already
    // has a hooks block cannot catch this, which is why it needed a full lifecycle run to find.
    const NO_HOOKS = '{\n    "model": "opus",\n    "env": {\n        "MY_VAR": "keep me"\n    }\n}\n';
    fs.writeFileSync(claudeSettings, NO_HOOKS);
    const store = freshStore();
    const beforeHash = sha256(fs.readFileSync(claudeSettings));
    applyInit(planInit(), store);
    assert.match(fs.readFileSync(claudeSettings, 'utf8'), /"hooks"/, 'sabotage landed: init added a hooks block');
    uninstall(store);
    assert.equal(fs.readFileSync(claudeSettings, 'utf8'), NO_HOOKS, 'no empty container may be left behind');
    assert.equal(sha256(fs.readFileSync(claudeSettings)), beforeHash);
    store.close();
  });

  test('G5: uninstall PRESERVES a hooks block the user already had', () => {
    const store = freshStore();
    const beforeHash = sha256(fs.readFileSync(claudeSettings));
    applyInit(planInit(), store);
    uninstall(store);
    // PRE_EXISTING has a hooks block with a foreign Stop hook; it must survive intact.
    assert.match(fs.readFileSync(claudeSettings, 'utf8'), /"Stop"/);
    assert.equal(sha256(fs.readFileSync(claudeSettings)), beforeHash);
    store.close();
  });

  test('G5: uninstall restores the config byte-identically', () => {
    const store = freshStore();
    const beforeHash = sha256(fs.readFileSync(claudeSettings));
    applyInit(planInit(), store);
    assert.notEqual(sha256(fs.readFileSync(claudeSettings)), beforeHash, 'sabotage landed: init really changed the file');
    uninstall(store);
    assert.equal(sha256(fs.readFileSync(claudeSettings)), beforeHash, 'G5: byte-identical after uninstall');
    store.close();
  });

  test('G5: restore-configs also restores byte-identically', () => {
    const store = freshStore();
    const beforeHash = sha256(fs.readFileSync(claudeSettings));
    const res = applyInit(planInit(), store);
    // Make an extra unrelated mess so we can see restore really replaces the file.
    fs.appendFileSync(claudeSettings, '\n');
    const r = restoreConfigs(res.backupDir!);
    assert.equal(r.errors.length, 0);
    assert.ok(r.restored.every((x) => x.byteIdentical));
    assert.equal(sha256(fs.readFileSync(claudeSettings)), beforeHash);
    store.close();
  });

  test('G7: creating a previously-absent config is flagged, and restore DELETES it again', () => {
    fs.rmSync(claudeSettings);
    const store = freshStore();
    const changes = planInit();
    assert.equal(changes[0]!.creates, true, 'G7: creation of an absent protected file is a mutation');
    const res = applyInit(changes, store);
    assert.equal(fs.existsSync(claudeSettings), true);
    const r = restoreConfigs(res.backupDir!);
    assert.equal(fs.existsSync(claudeSettings), false, 'restore must remove a file usewarden conjured');
    assert.equal(r.restored[0]!.action, 'deleted');
    store.close();
  });

  test('G6: integrity hash is recorded and matches what is on disk', () => {
    const store = freshStore();
    applyInit(planInit(), store);
    const recs = store.listIntegrity();
    assert.equal(recs.length, 1);
    assert.equal(recs[0]!.hash, integrityHash(extractUsewardenEntries(claudeSettings, 'claude')));
    store.close();
  });
});

describe('status states', () => {
  function initialized(): Store {
    const store = freshStore();
    applyInit(planInit(), store);
    fs.writeFileSync(path.join(sb.usewardenHome, 'usewarden.yaml'), 'version: 1\n');
    return store;
  }

  test('PROTECTED after a clean init', () => {
    const store = initialized();
    const r = buildStatus(store, sb.repo);
    assert.equal(r.overall, 'PROTECTED');
    assert.equal(r.agents[0]!.state, 'PROTECTED');
    store.close();
  });

  test('MANDATORY: hook registration removed -> UNPROTECTED', () => {
    const store = initialized();
    // sabotage
    const f = readJsonFile(claudeSettings);
    removeEntries(f, 'claude');
    fs.writeFileSync(claudeSettings, serialize(f));
    // assert the sabotage LANDED before asserting the catch
    assert.equal(extractUsewardenEntries(claudeSettings, 'claude'), null, 'sabotage landed: entries really gone');
    const r = buildStatus(store, sb.repo);
    assert.equal(r.overall, 'UNPROTECTED');
    assert.match(r.agents[0]!.detail, /GONE/);
    store.close();
  });

  test('disableAllHooks -> UNPROTECTED even though the entries are intact', () => {
    const store = initialized();
    const f = readJsonFile(claudeSettings);
    f.value['disableAllHooks'] = true;
    fs.writeFileSync(claudeSettings, serialize(f));
    assert.equal(readJsonFile(claudeSettings).value['disableAllHooks'], true, 'sabotage landed');
    assert.notEqual(extractUsewardenEntries(claudeSettings, 'claude'), null, 'entries are still present');
    const r = buildStatus(store, sb.repo);
    assert.equal(r.overall, 'UNPROTECTED');
    store.close();
  });

  test('tampered usewarden entry -> TAMPERED, and the swapped command is named', () => {
    const store = initialized();
    const raw = fs.readFileSync(claudeSettings, 'utf8');
    const sabotaged = raw.replace(usewardenScriptPath(), '/tmp/evil.sh');
    assert.notEqual(sabotaged, raw, 'sabotage landed: the command string really changed');
    fs.writeFileSync(claudeSettings, sabotaged);
    const r = buildStatus(store, sb.repo);
    assert.equal(r.overall, 'TAMPERED');
    assert.equal(r.agents[0]!.commandPointsAtUsewarden, false);
    store.close();
  });

  test('T-08 escape hatch: USEWARDEN_ALLOW_CONFIG_WRITE=1 suppresses TAMPERED but not UNPROTECTED', () => {
    const store = initialized();
    // A benign user edit that changes the hash but keeps usewarden's command intact.
    const f = readJsonFile(claudeSettings);
    const hooks = f.value['hooks'] as Record<string, unknown>;
    (hooks['PreToolUse'] as Record<string, unknown>[])[0]!['matcher'] = 'Bash';
    fs.writeFileSync(claudeSettings, serialize(f));
    assert.equal(buildStatus(store, sb.repo).overall, 'TAMPERED', 'locked: reports TAMPERED');

    process.env['USEWARDEN_ALLOW_CONFIG_WRITE'] = '1';
    try {
      assert.equal(buildStatus(store, sb.repo).overall, 'PROTECTED', 'unlocked: user edits are their own business');
      // But removal is still reported even when unlocked.
      const g = readJsonFile(claudeSettings);
      removeEntries(g, 'claude');
      fs.writeFileSync(claudeSettings, serialize(g));
      assert.equal(buildStatus(store, sb.repo).overall, 'UNPROTECTED', 'the hatch must never hide a missing guardian');
    } finally {
      delete process.env['USEWARDEN_ALLOW_CONFIG_WRITE'];
    }
    store.close();
  });

  test('T-08: usewarden REPORTS a config change, it never blocks one', () => {
    const store = initialized();
    // Simulate the documented `claude plugin install` lockout scenario: a third party adds a key.
    const f = readJsonFile(claudeSettings);
    f.value['plugins'] = { installed: ['some-plugin'] };
    const written = serialize(f);
    fs.writeFileSync(claudeSettings, written);
    assert.equal(fs.readFileSync(claudeSettings, 'utf8'), written, 'the write SUCCEEDED - usewarden is not a lock');
    assert.equal(buildStatus(store, sb.repo).overall, 'PROTECTED', 'an unrelated key must not trip tamper detection');
    store.close();
  });

  test('POLICY_INVALID when usewarden.yaml does not parse - loud, never a silent default-allow', () => {
    const store = initialized();
    fs.writeFileSync(path.join(sb.usewardenHome, 'usewarden.yaml'), 'version: 1\nscope:\n\t- tabs are illegal\n');
    const r = buildStatus(store, sb.repo);
    assert.equal(r.overall, 'POLICY_INVALID');
    assert.match(r.policyError!, /POLICY_INVALID/);
    store.close();
  });

  test('UNPROTECTED before init has ever run', () => {
    const store = freshStore();
    const r = buildStatus(store, sb.repo);
    assert.equal(r.overall, 'UNPROTECTED');
    store.close();
  });
});
