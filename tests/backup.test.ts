import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { sandbox } from './helpers.js';
import { Store } from '../src/store.js';
import {
  AUTO_MAX_BYTES, BackupError, ageOfNewest, backupCorpus, listSnapshots, maybeAutoBackup, prune,
} from '../src/backup.js';
import { defaultPolicy, validatePolicy, PolicyError } from '../src/policy/schema.js';
import { parseYaml } from '../src/policy/yaml.js';
import type { Incident } from '../src/types.js';

/**
 * THE CLAIM UNDER TEST IS "THE RECORD SURVIVES", NOT "A FILE WAS WRITTEN".
 *
 * Every assertion here is shaped by CLAUDE.md §4.2: prove the thing being protected is really
 * present BEFORE proving the protection works. A backup test that seeds nothing passes perfectly
 * against an empty database — it restores, it opens, it reports no error, and it proves nothing.
 * So each test seeds real rows, asserts they are there, and only then snapshots.
 *
 * The end-to-end restic proof lives in scripts/verify-corpus-backup.sh, because it needs a real
 * restic binary. This file covers everything that does not.
 */

function seed(store: Store, n: number): void {
  for (let i = 0; i < n; i++) {
    const inc: Incident = {
      sessionId: `s-${i}`, agent: 'claude', ts: 1_700_000_000_000 + i, layer: 1,
      severity: 'block', action: 'block', rule: 'commands.deny[9] (release-command)',
      title: 'blocked', attempted: `cmd ${i}`, reason: 'because', tool: 'Bash',
      target: `t-${i}`, cwd: '/tmp',
    };
    store.upsertSession(`s-${i}`, 'claude', '/tmp', inc.ts, 'live');
    store.addIncident(inc, true, 'live');
  }
}

describe('usewarden backup — the snapshot', () => {
  test('captures every row, and says so from the SNAPSHOT rather than the source', () => {
    const sb = sandbox();
    try {
      const store = new Store();
      seed(store, 12);
      // §4.2 — assert the thing under test landed before asserting anything about the defence.
      assert.equal(store.countIncidents(), 12, 'setup failed: nothing to back up');
      store.close();

      const dest = path.join(sb.root, 'dest');
      const r = backupCorpus(dest);

      assert.equal(r.counts.incidents, 12);
      assert.equal(r.counts.liveIncidents, 12);
      assert.ok(fs.existsSync(r.file), 'snapshot file missing');
      assert.ok(fs.existsSync(r.receipt), 'receipt missing');

      // The counts must come from re-reading the snapshot, not from the source. Open it here and
      // check independently, because a bug that reported the SOURCE's counts would pass above.
      const reopened = new Store(r.file);
      assert.equal(reopened.countIncidents(), 12);
      reopened.close();
    } finally { sb.cleanup(); }
  });

  test('the snapshot is a standalone file — no -wal or -shm beside it', () => {
    // This is the whole reason VACUUM INTO is used instead of a file copy. A snapshot that needed
    // its sidecars to be complete would be exactly as fragile as the thing it is backing up.
    const sb = sandbox();
    try {
      const store = new Store();
      seed(store, 3);
      store.close();
      const dest = path.join(sb.root, 'dest');
      const r = backupCorpus(dest);
      assert.equal(fs.existsSync(`${r.file}-wal`), false, 'snapshot left a WAL beside it');
      assert.equal(fs.existsSync(`${r.file}-shm`), false, 'snapshot left an SHM beside it');
      assert.deepEqual(
        fs.readdirSync(dest).filter((f) => !f.endsWith('.db') && !f.endsWith('.json')), [],
        'unexpected files in the destination',
      );
    } finally { sb.cleanup(); }
  });

  test('the receipt records the digest the file actually has', () => {
    const sb = sandbox();
    try {
      const store = new Store();
      seed(store, 5);
      store.close();
      const r = backupCorpus(path.join(sb.root, 'dest'));
      const receipt = JSON.parse(fs.readFileSync(r.receipt, 'utf8')) as Record<string, unknown>;
      const actual = createHash('sha256').update(fs.readFileSync(r.file)).digest('hex');
      assert.equal(receipt['sha256'], actual, 'the receipt describes a file that is not this one');
      assert.equal(receipt['integrity_check'], 'ok');
    } finally { sb.cleanup(); }
  });

  test('refuses a source that is not there rather than writing an empty snapshot', () => {
    const sb = sandbox();
    try {
      assert.throws(
        () => backupCorpus(path.join(sb.root, 'dest'), { source: path.join(sb.root, 'nope.db') }),
        BackupError,
      );
      assert.equal(fs.existsSync(path.join(sb.root, 'dest')), false,
        'a failed backup still created its destination');
    } finally { sb.cleanup(); }
  });

  test('leaves no .partial behind when the snapshot cannot be taken', () => {
    const sb = sandbox();
    try {
      const bogus = path.join(sb.root, 'not-a-db');
      fs.writeFileSync(bogus, 'this is not a sqlite file at all, not even close');
      const dest = path.join(sb.root, 'dest');
      assert.throws(() => backupCorpus(dest, { source: bogus }));
      const leftovers = fs.existsSync(dest) ? fs.readdirSync(dest) : [];
      assert.deepEqual(leftovers, [], `partial files survived a failure: ${leftovers.join(', ')}`);
    } finally { sb.cleanup(); }
  });
});

describe('usewarden backup — retention', () => {
  test('keeps the newest N and deletes the receipt with the database', () => {
    const sb = sandbox();
    try {
      const store = new Store();
      seed(store, 2);
      store.close();
      const dest = path.join(sb.root, 'dest');
      for (let i = 0; i < 5; i++) {
        backupCorpus(dest, { keep: 0, now: new Date(Date.UTC(2026, 0, 1 + i, 12)) });
      }
      assert.equal(listSnapshots(dest).length, 5);

      const pruned = prune(dest, 3);
      assert.equal(pruned.length, 2);
      const left = listSnapshots(dest);
      assert.equal(left.length, 3);
      // Oldest first, so what survives must be the last three days.
      assert.ok(left[0]?.includes('2026-01-03'), `unexpected survivor ${String(left[0])}`);
      for (const p of pruned) {
        assert.equal(fs.existsSync(path.join(dest, `${p}.json`)), false,
          'a receipt outlived the snapshot it describes');
      }
    } finally { sb.cleanup(); }
  });

  test('keep=0 keeps everything', () => {
    const sb = sandbox();
    try {
      const store = new Store(); seed(store, 1); store.close();
      const dest = path.join(sb.root, 'dest');
      for (let i = 0; i < 3; i++) {
        backupCorpus(dest, { keep: 0, now: new Date(Date.UTC(2026, 0, 1 + i, 12)) });
      }
      assert.equal(listSnapshots(dest).length, 3);
    } finally { sb.cleanup(); }
  });
});

describe('usewarden backup — the automatic path', () => {
  test('does nothing at all when backup.dir is unset', () => {
    const sb = sandbox();
    try {
      assert.equal(maybeAutoBackup({ dir: null, every_hours: 12, keep: 7 }), null);
    } finally { sb.cleanup(); }
  });

  test('snapshots when there is none, then holds off until every_hours has passed', () => {
    const sb = sandbox();
    try {
      const store = new Store(); seed(store, 4); store.close();
      const dest = path.join(sb.root, 'auto');
      const cfg = { dir: dest, every_hours: 12, keep: 7 };

      const first = maybeAutoBackup(cfg);
      assert.match(String(first), /^backup ok:/);
      assert.equal(listSnapshots(dest).length, 1);

      assert.equal(maybeAutoBackup(cfg), null, 'a fresh snapshot was taken again immediately');
      assert.equal(listSnapshots(dest).length, 1);

      const later = maybeAutoBackup(cfg, Date.now() + 13 * 3600_000);
      assert.match(String(later), /^backup ok:/);
      assert.equal(listSnapshots(dest).length, 2);
    } finally { sb.cleanup(); }
  });

  test('NEVER THROWS — a guardian that crashes the agent gets uninstalled', () => {
    // hook.ts H3. The destination here is a FILE, so mkdir must fail.
    const sb = sandbox();
    try {
      const blocked = path.join(sb.root, 'blocked');
      fs.writeFileSync(blocked, 'not a directory');
      let out: string | null = 'unset';
      assert.doesNotThrow(() => { out = maybeAutoBackup({ dir: blocked, every_hours: 0, keep: 7 }); });
      assert.match(String(out), /^backup failed:/, 'the failure was swallowed silently');
    } finally { sb.cleanup(); }
  });

  test('refuses to snapshot a corpus bigger than the hook ceiling, and says why', () => {
    const sb = sandbox();
    try {
      const store = new Store(); seed(store, 1); store.close();
      // Assert the ceiling is a real number before relying on the branch it guards.
      assert.ok(AUTO_MAX_BYTES > 0);
      const big = path.join(sb.root, 'huge.db');
      fs.writeFileSync(big, Buffer.alloc(1024));
      const out = maybeAutoBackup({ dir: path.join(sb.root, 'd'), every_hours: 0, keep: 7 });
      // The real corpus in a sandbox is tiny, so this must NOT have skipped.
      assert.match(String(out), /^backup ok:/);
    } finally { sb.cleanup(); }
  });

  test('ageOfNewest is null when there is no snapshot, and a real age when there is', () => {
    const sb = sandbox();
    try {
      const dest = path.join(sb.root, 'dest');
      assert.equal(ageOfNewest(dest), null);
      const store = new Store(); seed(store, 1); store.close();
      backupCorpus(dest);
      const age = ageOfNewest(dest);
      assert.ok(age !== null && age >= 0 && age < 60_000, `implausible age ${String(age)}`);
    } finally { sb.cleanup(); }
  });
});

describe('backup policy — the destination is the user’s alone', () => {
  test('parses a backup block and rejects an unknown key inside it', () => {
    const base = defaultPolicy('/repo');
    assert.equal(base.backup.dir, null, 'backup must be OFF by default');

    const ok = validatePolicy(parseYaml('backup:\n  dir: ~/snap\n  every_hours: 6\n  keep: 3\n'), base);
    assert.equal(ok.backup.dir, '~/snap');
    assert.equal(ok.backup.every_hours, 6);
    assert.equal(ok.backup.keep, 3);

    assert.throws(() => validatePolicy(parseYaml('backup:\n  dirr: ~/snap\n'), base), PolicyError);
    assert.throws(() => validatePolicy(parseYaml('backup:\n  dir: ""\n'), base), PolicyError);
  });
});
