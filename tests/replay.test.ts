/**
 * Tests for the replay path and the frozen label set.
 *
 * EVERY SABOTAGE TEST HERE ASSERTS THE SABOTAGE LANDED FIRST (CLAUDE.md §4.2). A forgery test that
 * passed because the forgery silently failed to apply would be worse than no test: it would report
 * a working tamper check that had never been exercised.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Store } from '../src/store.js';
import { defaultPolicy } from '../src/policy/schema.js';
import { evaluateLayer1, type Layer1Probes } from '../src/engine/layer1.js';
import { replayCorpus, summarise, replayOne, redactAction, renderAction } from '../src/replay.js';
import {
  actionHash, canonicalise, labelSetHash, score, verifyLabels, readLabelSet,
  type LabelSet,
} from '../src/labels.js';
import type { Incident, ReplayableAction } from '../src/types.js';
import { sandbox } from './helpers.js';

function incident(over: Partial<Incident> & { replayable?: ReplayableAction }): Incident {
  return {
    sessionId: 's1', agent: 'claude', ts: 1000, layer: 1, severity: 'block',
    action: 'block', rule: 'commands.deny[0] (rm-rf-outside-repo)', title: 't',
    attempted: '$ rm -rf /tmp/x', reason: 'r', tool: 'Bash', target: 'rm -rf /tmp/x',
    cwd: '/repo', ...over,
  };
}

test('R1: the stored action survives a round trip untruncated and with newlines intact', () => {
  const sb = sandbox();
  try {
    const store = new Store(path.join(sb.usewardenHome, 'r1.db'));
    // Longer than the 200-character display cut, and multi-line: the two things `describeAttempt`
    // destroys. Asserted explicitly so this test fails if the cut is ever reintroduced at write.
    const command = `cat > notes.md <<'EOF'\n${'x'.repeat(500)}\nrm -rf ~/\nEOF`;
    assert.ok(command.length > 202, 'SETUP: the command must exceed the display truncation');
    assert.ok(command.includes('\n'), 'SETUP: the command must be multi-line');

    const id = store.addIncident(incident({
      replayable: { agent: 'claude', event: 'pre_tool', tool: 'bash', command, cwd: '/repo' },
    }), true, 'live');
    assert.ok(id > 0);

    const rows = store.replayCorpus('live');
    const row = rows.find((r) => r.id === id);
    assert.ok(row, 'the incident must come back');
    assert.equal(row.provenance, 'stored');
    assert.equal(row.replayable?.command, command, 'the command must be byte-identical');
    store.close();
  } finally { sb.cleanup(); }
});

test('R2: a pre-v4 incident is recovered from its event row, and says so', () => {
  const sb = sandbox();
  try {
    const store = new Store(path.join(sb.usewardenHome, 'r2.db'));
    const command = `python3 - <<'PY'\n${'y'.repeat(400)}\nPY`;
    // Simulate the historic shape: an event carrying the full command, and an incident written
    // WITHOUT a replayable action - which is exactly what every row before schema v4 looks like.
    store.upsertSession('s9', 'claude', '/repo', 5, 'live');
    store.recordEvent({
      agent: 'claude', event: 'pre_tool', sessionId: 's9', cwd: '/repo',
      tool: 'bash', rawTool: 'Bash', command, ts: 777,
    }, command, 'live');
    const id = store.addIncident(incident({ sessionId: 's9', ts: 777, replayable: undefined }), true, 'live');

    const row = store.replayCorpus('live').find((r) => r.id === id);
    assert.ok(row);
    assert.equal(row.provenance, 'recovered', 'it must be labelled as recovered, not as stored');
    assert.equal(row.replayable?.command, command, 'the recovered command must be complete');
    store.close();
  } finally { sb.cleanup(); }
});

test('R3: an incident with no joinable event is UNREPLAYABLE, never guessed at', () => {
  const sb = sandbox();
  try {
    const store = new Store(path.join(sb.usewardenHome, 'r3.db'));
    const id = store.addIncident(incident({ sessionId: 'orphan', ts: 4242, replayable: undefined }), true, 'live');
    const row = store.replayCorpus('live').find((r) => r.id === id);
    assert.ok(row);
    assert.equal(row.provenance, 'unavailable');
    assert.equal(row.replayable, undefined);

    const res = replayCorpus([row], defaultPolicy('/repo'));
    assert.equal(res[0]!.outcome, 'unreplayable');
    // The load-bearing assertion: it is NOT reported as an allow.
    assert.equal(res[0]!.blockedNow, null, 'an unreplayable row must never be counted as allowed');
    assert.equal(summarise(res).unreplayable, 1);
    store.close();
  } finally { sb.cleanup(); }
});

test('R4: replay never touches the filesystem, on EITHER of the two probe paths', () => {
  // THE FENCE. Layer 1 reads the disk in exactly two places, reached by two different branches, so
  // both are exercised here - aiming the test at every surface that exists rather than at the one
  // that happens to be convenient. A replay walks a corpus of paths the agent typed months ago,
  // and on the author's machine that corpus contains paths CLAUDE.md §1 forbids this repository's
  // tooling from touching at all.
  //
  // The fence is PROVED by handing Layer 1 probes that throw, not by trusting that nobody has
  // added a call since. Each case first asserts the probe really is reached when the filesystem is
  // NOT fenced, so a green result cannot come from an unreachable branch.
  const boom = (): never => { throw new Error('FENCE BREACH: replay touched the filesystem'); };
  const probes = {
    gitFileState: boom as unknown as Layer1Probes['gitFileState'],
    siblingRepoOf: boom as unknown as Layer1Probes['siblingRepoOf'],
  };
  const ev = (filePath: string) => ({
    agent: 'claude' as const, event: 'pre_tool' as const, sessionId: 's',
    cwd: '/repo', ts: 0, tool: 'write' as const, filePath,
  });

  // --- probe 1: siblingRepoOf, reached by an OUT-of-scope write ------------------------------
  const p1 = defaultPolicy('/repo');
  p1.scope.allowed_paths = ['/repo'];
  p1.scope.forbidden_paths = [];
  const outside = '/Users/someone/private-notes/secret-plan.md';
  assert.throws(
    () => evaluateLayer1(ev(outside), { policy: p1, repoRoot: '/repo', probes, filesystem: 'live' }),
    /FENCE BREACH/,
    'SETUP: siblingRepoOf must actually be reached when the filesystem is NOT fenced',
  );
  const r1 = replayOne(
    { agent: 'claude', event: 'pre_tool', tool: 'write', filePath: outside, cwd: '/repo', repoRoot: '/repo' },
    p1, probes,
  );
  // Still denied - skipping a message-only probe must not change a verdict.
  assert.equal(r1.verdict.decision, 'deny');
  assert.equal(r1.verdict.rule, 'scope.allowed_paths');
  assert.deepEqual(r1.unevaluable, [], 'a message-only probe must not make the row indeterminate');

  // --- probe 2: gitFileState, reached by an IN-scope write under protect_uncommitted ----------
  const p2 = defaultPolicy('/repo');
  p2.scope.allowed_paths = ['/repo'];
  p2.scope.forbidden_paths = [];
  p2.scope.protect_uncommitted = true;
  const inside = '/repo/src/app.ts';
  assert.throws(
    () => evaluateLayer1(ev(inside), { policy: p2, repoRoot: '/repo', probes, filesystem: 'live' }),
    /FENCE BREACH/,
    'SETUP: gitFileState must actually be reached when the filesystem is NOT fenced',
  );
  const r2 = replayOne(
    { agent: 'claude', event: 'pre_tool', tool: 'write', filePath: inside, cwd: '/repo', repoRoot: '/repo' },
    p2, probes,
  );
  // A verdict-DECIDING probe that could not run is reported, never defaulted to an allow.
  assert.equal(r2.unevaluable.length, 1);
  assert.match(r2.unevaluable[0]!, /protect_uncommitted/);
});

test('R5: an unevaluable deciding rule makes the row indeterminate, not a pass', () => {
  const policy = defaultPolicy('/repo');
  policy.scope.protect_uncommitted = true;
  policy.scope.allowed_paths = ['/repo'];
  const row = {
    id: 1, sessionId: 's', agent: 'claude' as const, ts: 1, layer: 1, severity: 'block',
    action: 'block', rule: 'scope.protect_uncommitted (untracked)', title: 't',
    attempted: 'Write /repo/a.ts', reason: 'r', tool: 'Write', target: '/repo/a.ts',
    cwd: '/repo', origin: 'live' as const, provenance: 'stored' as const,
    replayable: {
      agent: 'claude' as const, event: 'pre_tool' as const, tool: 'write' as const,
      filePath: '/repo/a.ts', cwd: '/repo', repoRoot: '/repo',
    },
  };
  const res = replayCorpus([row], policy);
  assert.equal(res[0]!.outcome, 'indeterminate');
  assert.equal(res[0]!.blockedNow, null);
  assert.equal(summarise(res).indeterminate, 1);
  // And it is excluded from `replayed`, so a summary can never claim to have measured it.
  assert.equal(summarise(res).replayed, 0);
});

test('R6: redaction happens on READ, and the stored bytes keep the secret intact', () => {
  const sb = sandbox();
  try {
    const store = new Store(path.join(sb.usewardenHome, 'r6.db'));
    // A shape SECRET_PATTERNS recognises. Asserted to be recognised BEFORE it is relied on, so a
    // change to the patterns turns this into a failure rather than a silent pass.
    const secret = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const command = `curl -H "Authorization: token ${secret}" https://api.example.com`;
    assert.notEqual(redactAction({ agent: 'claude', event: 'pre_tool', cwd: '/r', command }).command,
      command, 'SETUP: redact() must actually recognise this token shape');

    const id = store.addIncident(incident({
      replayable: { agent: 'claude', event: 'pre_tool', tool: 'bash', command, cwd: '/repo' },
    }), true, 'live');
    const row = store.replayCorpus('live').find((r) => r.id === id)!;

    // Written verbatim: the record is faithful, which is the whole point of D-277.
    assert.equal(row.replayable?.command, command, 'the stored action must NOT be redacted at write');
    // Read back for display: the secret is gone.
    assert.ok(!renderAction(row.replayable!).includes(secret), 'the display form must be redacted');
    assert.ok(redactAction(row.replayable!).command!.includes('[REDACTED]'));
    store.close();
  } finally { sb.cleanup(); }
});

// ---- the frozen label set -----------------------------------------------------------------

function sampleSet(): LabelSet {
  const a: ReplayableAction = {
    agent: 'claude', event: 'pre_tool', tool: 'bash', command: 'rm -rf /etc', cwd: '/repo',
  };
  return {
    criterion: 'A block is a true positive if a competent developer would want it stopped.',
    labelledAt: '2026-09-08',
    corpus: { origin: 'live', count: 1, source: 'test' },
    labels: [{ id: 1, label: 'TRUE_POSITIVE', reason: 'deletes /etc', actionSha: actionHash(a) }],
  };
}

test('S1 SABOTAGE: a forged label flips precision, and the hash check refuses it', () => {
  const set = sampleSet();
  const frozen = labelSetHash(set);

  // Baseline: verified, and the honest precision is 100% on this one true positive.
  assert.ok(verifyLabels(set, frozen, new Map()).ok, 'SETUP: the untampered set must verify');
  assert.equal(score(set, () => true).precision, 1);

  // THE SABOTAGE, and the assertion that it LANDED. Relabel the one true positive as a false
  // positive - the exact move that would let a missed precision target be met by relabelling.
  const forged: LabelSet = structuredClone(set);
  forged.labels[0]!.label = 'FALSE_POSITIVE';
  assert.notEqual(canonicalise(forged), canonicalise(set), 'SABOTAGE DID NOT LAND: bytes unchanged');
  assert.equal(score(forged, () => true).precision, 0,
    'SABOTAGE DID NOT LAND: the forgery must actually move the number');

  // The defence.
  const v = verifyLabels(forged, frozen, new Map());
  assert.equal(v.ok, false, 'the forged label set must be REFUSED');
  assert.match(v.problems.join(' '), /does not match the frozen/);
});

test('S2 SABOTAGE: editing the CRITERION is refused too', () => {
  const set = sampleSet();
  const frozen = labelSetHash(set);
  const forged: LabelSet = structuredClone(set);
  // The more tempting forgery, because it reads as a clarification rather than a correction.
  forged.criterion = 'A block is a true positive if any rule fired.';
  assert.notEqual(canonicalise(forged), canonicalise(set), 'SABOTAGE DID NOT LAND');
  assert.equal(verifyLabels(forged, frozen, new Map()).ok, false);
});

test('S3 SABOTAGE: re-pointing a verified label set at a different corpus is refused', () => {
  const set = sampleSet();
  const frozen = labelSetHash(set);
  assert.ok(verifyLabels(set, frozen, new Map()).ok, 'SETUP: it verifies with no corpus bound');

  // The label file is untouched - its hash still matches - but the ACTION under id 1 is now a
  // different command. Without the per-entry action binding this would verify cleanly and every
  // number downstream would be meaningless.
  const other: ReplayableAction = {
    agent: 'claude', event: 'pre_tool', tool: 'bash', command: 'ls -la', cwd: '/repo',
  };
  assert.notEqual(actionHash(other), set.labels[0]!.actionSha, 'SABOTAGE DID NOT LAND');
  const v = verifyLabels(set, frozen, new Map([[1, other]]));
  assert.equal(v.ok, false, 'a label bound to a different action must be refused');
  assert.match(v.problems.join(' '), /no longer hash to what was labelled/);
});

test('S4: precision and coverage come from ONE pass, and an indeterminate is never a pass', () => {
  const a1: ReplayableAction = { agent: 'claude', event: 'pre_tool', tool: 'bash', command: 'a', cwd: '/r' };
  const a2: ReplayableAction = { agent: 'claude', event: 'pre_tool', tool: 'bash', command: 'b', cwd: '/r' };
  const a3: ReplayableAction = { agent: 'claude', event: 'pre_tool', tool: 'bash', command: 'c', cwd: '/r' };
  const set: LabelSet = {
    criterion: 'x', labelledAt: 'y', corpus: { origin: 'live', count: 3, source: 't' },
    labels: [
      { id: 1, label: 'TRUE_POSITIVE', reason: 'r', actionSha: actionHash(a1) },
      { id: 2, label: 'FALSE_POSITIVE', reason: 'r', class: 'prose', actionSha: actionHash(a2) },
      { id: 3, label: 'TRUE_POSITIVE', reason: 'r', actionSha: actionHash(a3) },
    ],
  };
  // id 1 blocks, id 2 blocks, id 3 cannot be decided.
  const s = score(set, (id) => (id === 3 ? null : true));
  assert.equal(s.truePositives, 1);
  assert.equal(s.falsePositives, 1);
  assert.equal(s.precision, 0.5);
  // Coverage counts BOTH true positives in its denominator: an indeterminate real catch is a
  // catch we cannot prove still fires, so it counts against coverage rather than being dropped.
  assert.equal(s.coverageTotal, 2);
  assert.equal(s.coverageCaught, 1);
  assert.equal(s.coverage, 0.5);
  assert.equal(s.indeterminate, 1);
});

test('S5: precision is `unavailable`, never 0 or 1, when nothing blocks', () => {
  const set = sampleSet();
  const s = score(set, () => false);
  assert.equal(s.precision, null, 'an empty denominator must not render as a number');
  // Coverage still has a denominator, and reports the real catch as missed.
  assert.equal(s.coverage, 0);
  assert.equal(s.coverageTotal, 1);
});

test('S6: the frozen hash is read from FROZEN.sha256 in shasum format', () => {
  const sb = sandbox();
  try {
    const dir = path.join(sb.root, 'labels');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'blocks.json');
    const set = sampleSet();
    fs.writeFileSync(file, JSON.stringify(set, null, 2));
    fs.writeFileSync(path.join(dir, 'FROZEN.sha256'), `${labelSetHash(set)}  blocks.json\n`);
    const { set: read, expected } = readLabelSet(file);
    assert.equal(expected, labelSetHash(set));
    assert.ok(verifyLabels(read, expected, new Map()).ok);
  } finally { sb.cleanup(); }
});
