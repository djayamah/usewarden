/**
 * The value figures, and the two ways they could lie.
 *
 * A dashboard whose every counter goes UP when the tool is WRONG is the failure this module was
 * built against, so these tests are aimed at the two ways a value figure could be wrong in the
 * flattering direction: manufactured data reaching it, and "unknown" rendering as a number.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Store } from '../src/store.js';
import { defaultPolicy } from '../src/policy/schema.js';
import { buildValueReport, severityOfRule, type ValueReport } from '../src/value.js';
import { actionHash, labelSetHash, type LabelSet } from '../src/labels.js';
import type { Incident, IncidentOrigin, ReplayableAction } from '../src/types.js';
import { sandbox } from './helpers.js';

const RM: ReplayableAction = {
  agent: 'claude', event: 'pre_tool', tool: 'bash', command: 'rm -rf /etc', cwd: '/repo',
  repoRoot: '/repo',
};
const ENV: ReplayableAction = {
  agent: 'claude', event: 'pre_tool', tool: 'read', rawTool: 'Read',
  filePath: '/somewhere/else/.env', cwd: '/repo', repoRoot: '/repo',
};
const PROSE: ReplayableAction = {
  agent: 'claude', event: 'pre_tool', tool: 'bash', cwd: '/repo', repoRoot: '/repo',
  command: "grep -n 'npm publish' NOTES.md",
};

function incident(over: Partial<Incident> & { replayable: ReplayableAction }): Incident {
  return {
    sessionId: 's1', agent: 'claude', ts: Date.now(), layer: 1, severity: 'block',
    action: 'block', rule: 'commands.deny[0] (rm-rf-outside-repo)', title: 't',
    attempted: 'a', reason: 'r', tool: 'Bash', target: '', cwd: '/repo', ...over,
  };
}

function writeLabels(dir: string, entries: { id: number; label: string; cls: string; action: ReplayableAction }[]): string {
  fs.mkdirSync(dir, { recursive: true });
  const set: LabelSet = {
    criterion: 'a competent developer would want it stopped',
    labelledAt: '2026-09-08',
    corpus: { origin: 'live', count: entries.length, source: 'test' },
    labels: entries.map((e) => ({
      id: e.id, label: e.label as LabelSet['labels'][number]['label'],
      reason: 'r', class: e.cls, actionSha: actionHash(e.action),
    })),
  };
  const file = path.join(dir, 'labels.json');
  fs.writeFileSync(file, JSON.stringify(set, null, 2));
  fs.writeFileSync(path.join(dir, 'FROZEN.sha256'), `${labelSetHash(set)}  labels.json\n`);
  return file;
}

function policy(): ReturnType<typeof defaultPolicy> {
  const p = defaultPolicy('/repo');
  p.scope.allowed_paths = ['/repo'];
  return p;
}

test('V1 SABOTAGE: demo and fixture incidents cannot reach ANY value figure', () => {
  const sb = sandbox();
  try {
    const store = new Store(path.join(sb.usewardenHome, 'v1.db'));

    // THE SABOTAGE: fill the database with nothing but manufactured catches. Every one of these
    // is a genuine block by a genuine rule — they are simply not from a real session.
    for (const origin of ['demo', 'fixture'] as IncidentOrigin[]) {
      for (let i = 0; i < 12; i++) {
        store.addIncident(incident({
          sessionId: `${origin}-${i}`, ts: 1000 + i, replayable: RM,
        }), false, origin);
      }
    }
    // ASSERT THE SABOTAGE LANDED, before asserting the defence.
    assert.equal(store.replayCorpus('demo').length, 12, 'SETUP: demo rows were not written');
    assert.equal(store.replayCorpus('fixture').length, 12, 'SETUP: fixture rows were not written');
    assert.equal(store.replayCorpus('live').length, 0, 'SETUP: there must be no live rows');

    const labelsDir = path.join(sb.root, 'labels');
    const file = writeLabels(labelsDir, [{ id: 1, label: 'TRUE_POSITIVE', cls: 'x', action: RM }]);
    const v = buildValueReport({ store, policy: policy(), labelsFile: file });

    // The label set names an incident that is not in the LIVE corpus, so it is refused outright.
    assert.equal(v.precision.available, false, 'precision must not be computable from demo rows');
    assert.equal(v.coverage.available, false);
    assert.equal(v.truePositivesBySeverity.available, false);

    // And the manufactured rows are visible as EXCLUDED, never as a contribution.
    assert.equal(v.activity.liveBlocks, 0, '24 manufactured blocks must not become live blocks');
    assert.equal(v.activity.excludedDemo, 12);
    assert.equal(v.activity.excludedFixture, 12);
    store.close();
  } finally { sb.cleanup(); }
});

test('V2: with no label set, precision is UNAVAILABLE with a reason — never 0%, never 100%', () => {
  const sb = sandbox();
  try {
    const store = new Store(path.join(sb.usewardenHome, 'v2.db'));
    store.addIncident(incident({ replayable: RM }), true, 'live');
    assert.equal(store.replayCorpus('live').length, 1, 'SETUP: a live block must exist');

    const v = buildValueReport({ store, policy: policy(), labelsFile: undefined });
    assert.equal(v.precision.available, false);
    assert.match(v.precision.available ? '' : v.precision.reason, /no labelled incident set/i);
    // The failure this guards: a page that shows 0% and a reader who concludes the tool is broken,
    // or shows 100% and a reader who concludes it is perfect. Neither number exists.
    const rendered = JSON.stringify(v.precision);
    assert.ok(!/"pct"/.test(rendered), 'an unavailable figure must carry no number at all');
    // Activity is still reported: it is a fact about what happened, not a claim about value.
    assert.equal(v.activity.liveBlocks, 1);
    store.close();
  } finally { sb.cleanup(); }
});

test('V3: precision and coverage are computed together, from live rows only', () => {
  const sb = sandbox();
  try {
    const store = new Store(path.join(sb.usewardenHome, 'v3.db'));
    const tp = store.addIncident(incident({ sessionId: 'a', ts: 1, replayable: RM }), true, 'live');
    const tp2 = store.addIncident(incident({
      sessionId: 'b', ts: 2, rule: 'scope.forbidden_paths[5]', tool: 'Read',
      target: '/somewhere/else/.env', replayable: ENV,
    }), true, 'live');
    const fp = store.addIncident(incident({
      sessionId: 'c', ts: 3, rule: 'commands.deny[9] (npm-publish)', replayable: PROSE,
    }), true, 'live');
    // And a demo row that would flatter every figure if it leaked in.
    store.addIncident(incident({ sessionId: 'd', ts: 4, replayable: RM }), false, 'demo');

    const p = policy();
    p.scope.forbidden_paths = ['**/.env'];
    const file = writeLabels(path.join(sb.root, 'labels'), [
      { id: tp, label: 'TRUE_POSITIVE', cls: 'destructive', action: RM },
      { id: tp2, label: 'TRUE_POSITIVE', cls: 'credential-read', action: ENV },
      { id: fp, label: 'FALSE_POSITIVE', cls: 'quoted-argument', action: PROSE },
    ]);

    const v = buildValueReport({ store, policy: p, labelsFile: file });
    assert.ok(v.precision.available, `precision must be computable: ${JSON.stringify(v.precision)}`);
    assert.ok(v.coverage.available);

    // The false positive is fixed by the lexer, so it no longer blocks: 2 of 2 blocks are right.
    assert.equal(v.precision.value.truePositives, 2);
    assert.equal(v.precision.value.falsePositives, 0);
    assert.equal(v.precision.value.denominator, 2);
    assert.equal(v.precision.value.pct, 100);
    // Coverage keeps its own denominator and does not move with precision.
    assert.equal(v.coverage.value.caught, 2);
    assert.equal(v.coverage.value.total, 2);

    // The FP class is reported with BOTH numbers, so "still firing" is visibly zero.
    assert.ok(v.falsePositivesByClass.available);
    const row = v.falsePositivesByClass.value.find((r) => r.name === 'quoted-argument');
    assert.ok(row, 'the class must be listed even though it no longer fires');
    assert.equal(row.then, 1, 'it fired once when recorded');
    assert.equal(row.now, 0, 'and it does not fire now');
    store.close();
  } finally { sb.cleanup(); }
});

test('V4: true positives are split by severity, and a credential is not a chmod', () => {
  // Derived from the RULE, so it works on a machine that has never seen a label set.
  assert.equal(severityOfRule('scope.forbidden_paths[5]', '/x/.env'), 'critical');
  assert.equal(severityOfRule('scope.forbidden_paths[0]', '/home/u/.ssh/id_ed25519'), 'critical');
  assert.equal(severityOfRule('scope.allowed_paths', '/home/u/.usewarden/usewarden.yaml'), 'critical');
  assert.equal(severityOfRule('scope.forbidden_paths[10]', '/home/u/Documents/notes.md'), 'high');
  assert.equal(severityOfRule('commands.deny[0] (rm-rf-outside-repo)'), 'high');
  assert.equal(severityOfRule('commands.deny[8] (chmod-777)'), 'medium');
  assert.equal(severityOfRule('commands.deny[7] (history-rewrite)'), 'medium');
});

test('V5 SABOTAGE: a tampered label set makes every value figure unavailable, not wrong', () => {
  const sb = sandbox();
  try {
    const store = new Store(path.join(sb.usewardenHome, 'v5.db'));
    const fp = store.addIncident(incident({
      sessionId: 'c', ts: 3, rule: 'commands.deny[0] (rm-rf-outside-repo)', replayable: RM,
    }), true, 'live');
    const dir = path.join(sb.root, 'labels');
    const file = writeLabels(dir, [{ id: fp, label: 'FALSE_POSITIVE', cls: 'x', action: RM }]);

    const before = buildValueReport({ store, policy: policy(), labelsFile: file });
    assert.ok(before.precision.available, 'SETUP: the untampered set must produce a figure');
    assert.equal(before.precision.value.pct, 0, 'SETUP: one false positive, still firing, is 0%');

    // THE SABOTAGE: relabel it a true positive, which takes precision from 0% to 100%.
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as LabelSet;
    raw.labels[0]!.label = 'TRUE_POSITIVE';
    fs.writeFileSync(file, JSON.stringify(raw, null, 2));
    assert.notEqual(labelSetHash(raw), fs.readFileSync(path.join(dir, 'FROZEN.sha256'), 'utf8').slice(0, 64),
      'SABOTAGE DID NOT LAND: the hash still matches');

    const after = buildValueReport({ store, policy: policy(), labelsFile: file });
    assert.equal(after.precision.available, false, 'a tampered set must yield NO precision figure');
    assert.match(after.precision.available ? '' : after.precision.reason, /REFUSED/);
    // Not 100%, and not 0% either. Refused.
    assert.ok(!/"pct"/.test(JSON.stringify(after.precision)));
    store.close();
  } finally { sb.cleanup(); }
});

test('V6: arithmetic is re-checked on read, and a disagreement is unavailable rather than plausible', () => {
  // The invariants are internal, so this asserts the property they exist to guarantee: whenever a
  // figure IS available, its parts add up. A future refactor that broke one of the three
  // accumulators would make this fail rather than ship a number that merely looks reasonable.
  const sb = sandbox();
  try {
    const store = new Store(path.join(sb.usewardenHome, 'v6.db'));
    const a = store.addIncident(incident({ sessionId: 'a', ts: 1, replayable: RM }), true, 'live');
    const b = store.addIncident(incident({
      sessionId: 'b', ts: 2, rule: 'commands.deny[9] (npm-publish)', replayable: PROSE,
    }), true, 'live');
    const file = writeLabels(path.join(sb.root, 'labels'), [
      { id: a, label: 'TRUE_POSITIVE', cls: 'destructive', action: RM },
      { id: b, label: 'FALSE_POSITIVE', cls: 'quoted-argument', action: PROSE },
    ]);
    const v: ValueReport = buildValueReport({ store, policy: policy(), labelsFile: file });
    assert.ok(v.precision.available);
    assert.equal(
      v.precision.value.truePositives + v.precision.value.falsePositives,
      v.precision.value.denominator,
      'the denominator must be the sum of its parts',
    );
    assert.ok(v.truePositivesBySeverity.available);
    assert.equal(
      v.truePositivesBySeverity.value.reduce((x, r) => x + r.count, 0),
      v.precision.value.truePositives,
      'the severity split must sum to the true positives precision counted',
    );
    store.close();
  } finally { sb.cleanup(); }
});
