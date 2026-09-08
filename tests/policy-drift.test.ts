/**
 * POLICY DRIFT — has the ruleset become weaker than the one that was installed?
 *
 * The incident this is written against is in `src/policy/drift.ts`: on 2026-08-29 an agent that had
 * been refused a `Write` to `~/.usewarden/usewarden.yaml` — twice, and both refusals are in the
 * record — made the same edit from Bash with `sed -i`, and every surface usewarden has stayed
 * green for ten days.
 *
 * EVERY TEST HERE ASSERTS THE SABOTAGE LANDED FIRST (CLAUDE.md §4.2). Before asserting that the
 * detector notices a weakening, each test asserts that the weakened policy really does allow
 * something the sealed one refused. A detector test that passed because the "weakened" policy was
 * identical to the sealed one would be worse than no test at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sandbox } from './helpers.js';
import { Store } from '../src/store.js';
import { parsePolicyFile } from '../src/policy/load.js';
import { globalPolicyPath, policySealPath, policySealMetaPath } from '../src/paths.js';
import {
  compareToSeal, driftLines, isWeaker, probesFor, readSeal, sealPolicy,
} from '../src/policy/drift.js';
import { replayOne } from '../src/replay.js';
import type { Incident, ReplayableAction } from '../src/types.js';

const SEALED_YAML = `version: 1
scope:
  allowed_paths:
    - "/repo"
  forbidden_paths:
    - "~/.ssh"
    - "~/Documents"
    - "**/.env"
protected_branches:
  - "main"
`;

/** The 29 August edit, in miniature: one directory out of forbidden, into allowed. */
const WEAKENED_YAML = `version: 1
scope:
  allowed_paths:
    - "/repo"
    - "~/Documents/project"
  forbidden_paths:
    - "~/.ssh"
    - "~/Documents/private"
    - "**/.env"
protected_branches:
  - "main"
`;

const STRENGTHENED_YAML = `version: 1
scope:
  allowed_paths:
    - "/repo"
  forbidden_paths:
    - "~/.ssh"
    - "~/Documents"
    - "~/dev/other"
    - "**/.env"
    - "**/*.pem"
protected_branches:
  - "main"
  - "release"
`;

function writePolicies(sealedYaml: string, currentYaml: string): void {
  fs.writeFileSync(globalPolicyPath(), sealedYaml);
  const meta = sealPolicy('install');
  assert.ok(meta, 'SETUP: the seal must be written');
  fs.writeFileSync(globalPolicyPath(), currentYaml);
}

function readsAllowed(policyText: string, file: string): boolean {
  const p = path.join(process.env['USEWARDEN_HOME']!, 'probe-policy.yaml');
  fs.writeFileSync(p, policyText);
  const pol = parsePolicyFile(p, '/repo');
  const a: ReplayableAction = { agent: 'claude', event: 'pre_tool', tool: 'read', cwd: '/repo', filePath: file };
  return replayOne(a, pol).verdict.decision !== 'deny';
}

test('D1: a policy that lost a forbidden directory is reported as WEAKER, and the sabotage landed', () => {
  const sb = sandbox();
  try {
    const target = path.join(process.env['HOME'] ?? '/root', 'Documents', 'notes.md');
    // SABOTAGE LANDED FIRST: the sealed rules really do refuse this read, and the weakened rules
    // really do allow it. Without both halves the assertion below proves nothing.
    assert.equal(readsAllowed(SEALED_YAML, target), false, 'SETUP: the sealed policy must refuse this read');
    assert.equal(readsAllowed(WEAKENED_YAML, target), true, 'SETUP: the weakened policy must allow it');

    writePolicies(SEALED_YAML, WEAKENED_YAML);
    const r = compareToSeal({ base: '/repo' });

    assert.equal(r.unavailable, undefined, 'the comparison must be possible');
    assert.equal(r.changed, true, 'the bytes differ');
    assert.ok(isWeaker(r), 'this policy is weaker and must be reported as such');
    const labels = r.lostProbes.map((p) => p.label);
    assert.ok(labels.includes('reading inside ~/Documents'),
      `expected the lost read of ~/Documents, got:\n  ${labels.join('\n  ')}`);
    // The rule that used to catch it is named, so the user can find it in their own file.
    assert.ok(r.lostProbes.every((p) => p.ruleThen.length > 0));
  } finally { sb.cleanup(); }
});

test('D2: NO FALSE ALARM — an unchanged policy is not reported as weaker', () => {
  const sb = sandbox();
  try {
    writePolicies(SEALED_YAML, SEALED_YAML);
    const r = compareToSeal({ base: '/repo' });
    assert.equal(r.changed, false);
    assert.equal(isWeaker(r), false);
    assert.deepEqual(r.lostProbes, []);
    assert.deepEqual(r.downgradedProbes, []);
    assert.match(driftLines(r)[0]!, /Nothing has been weakened/);
  } finally { sb.cleanup(); }
});

test('D3: NO FALSE ALARM — a policy that was made STRICTER is not reported as weaker', () => {
  const sb = sandbox();
  try {
    // The failure mode this guards against is a detector that fires on any edit at all. A tool
    // that shouts when you tighten your own rules is a tool you switch off, and this project has
    // its own record of exactly that happening (docs/CHURN-2026-08-27.md).
    const target = path.join(process.env['HOME'] ?? '/root', 'dev', 'other', 'x.ts');
    assert.equal(readsAllowed(SEALED_YAML, target), true, 'SETUP: the sealed policy must allow this');
    assert.equal(readsAllowed(STRENGTHENED_YAML, target), false, 'SETUP: the stricter policy must refuse it');

    writePolicies(SEALED_YAML, STRENGTHENED_YAML);
    const r = compareToSeal({ base: '/repo' });
    assert.equal(r.changed, true, 'the bytes did change');
    assert.equal(isWeaker(r), false, 'but nothing was lost, so this is not a weakening');
    assert.ok(r.gainedProbes.length > 0, 'the additions are reported, not celebrated');
    assert.match(driftLines(r)[0]!, /nothing they used to catch has been lost/);
  } finally { sb.cleanup(); }
});

test('D4: a protection DOWNGRADED from absolute to project-conditional is reported separately', () => {
  const sb = sandbox();
  try {
    const dir = path.join(process.env['HOME'] ?? '/root', 'Documents', 'other', 'x.md');
    // The exact shape of the 29 August edit: writes to ~/Documents are STILL refused — by
    // `allowed_paths`, which holds only while you are standing in this project — where they used
    // to be refused by `forbidden_paths`, which held everywhere. Counting blocks would miss it.
    writePolicies(SEALED_YAML, WEAKENED_YAML);
    const r = compareToSeal({ base: '/repo' });
    const down = r.downgradedProbes.map((p) => p.label);
    assert.ok(down.includes('writing inside ~/Documents'),
      `expected the downgraded write of ~/Documents, got:\n  ${down.join('\n  ')}`);
    const p = r.downgradedProbes.find((x) => x.label === 'writing inside ~/Documents')!;
    assert.match(p.ruleThen, /forbidden_paths/);
    assert.equal(p.ruleNow, 'scope.allowed_paths');
    assert.ok(isWeaker(r), 'a downgrade on its own is enough to call the policy weaker');
  } finally { sb.cleanup(); }
});

test('D5: real recorded blocks that would no longer fire are named, using the corpus', () => {
  const sb = sandbox();
  try {
    const store = new Store(path.join(sb.usewardenHome, 'd5.db'));
    const home = process.env['HOME'] ?? '/root';
    const inc = (file: string): Incident => ({
      sessionId: 's1', agent: 'claude', ts: 1000, layer: 1, severity: 'block', action: 'block',
      rule: 'scope.forbidden_paths[1]', title: 'blocked', attempted: `Write ${file}`,
      reason: 'r', tool: 'Write', target: file, cwd: '/repo',
      replayable: { agent: 'claude', event: 'pre_tool', tool: 'write', cwd: '/repo', filePath: file },
    });
    const kept = path.join(home, '.ssh', 'config');
    const lost = path.join(home, 'Documents', 'project', 'a.ts');
    store.addIncident(inc(kept), true, 'live');
    store.addIncident(inc(lost), true, 'live');
    const rows = store.replayCorpus('live');
    assert.equal(rows.length, 2, 'SETUP: both incidents must be stored and replayable');

    // SABOTAGE LANDED: exactly one of the two stops being blocked.
    assert.equal(readsAllowed(SEALED_YAML, lost), false, 'SETUP: sealed refuses');
    assert.equal(readsAllowed(WEAKENED_YAML, lost), true, 'SETUP: weakened allows');

    writePolicies(SEALED_YAML, WEAKENED_YAML);
    const r = compareToSeal({ base: '/repo', rows });
    assert.equal(r.corpusConsidered, 2);
    assert.equal(r.lostCatches.length, 1, 'exactly the one that stopped being blocked');
    assert.ok(r.lostCatches[0]!.attempted.includes('a.ts'));
    store.close();
  } finally { sb.cleanup(); }
});

test('D6: with no seal the answer is UNVERIFIED, never a pass', () => {
  const sb = sandbox();
  try {
    fs.writeFileSync(globalPolicyPath(), WEAKENED_YAML);
    const r = compareToSeal({ base: '/repo' });
    assert.ok(r.unavailable, 'a machine with no baseline cannot report a clean bill of health');
    assert.equal(isWeaker(r), false, 'and it must not claim a weakening it cannot see either');
    assert.match(driftLines(r)[0]!, /^UNVERIFIED/);
  } finally { sb.cleanup(); }
});

test('D7: a FORGED seal is refused — and the forgery is proved to have been applied', () => {
  const sb = sandbox();
  try {
    writePolicies(SEALED_YAML, WEAKENED_YAML);
    assert.ok(readSeal(), 'SETUP: a valid seal must exist before it is forged');

    // The forgery: swap the sealed COPY for the weakened rules while leaving the metadata's hash
    // claiming the original. That is what an attacker who wanted the drift report to come back
    // clean would do, and it must not work.
    const before = fs.readFileSync(policySealPath(), 'utf8');
    fs.writeFileSync(policySealPath(), WEAKENED_YAML);
    assert.notEqual(fs.readFileSync(policySealPath(), 'utf8'), before,
      'SETUP FAILED: the forgery did not apply, so this test proves nothing');

    assert.equal(readSeal(), null, 'a seal whose copy no longer matches its own hash is worthless');
    const r = compareToSeal({ base: '/repo' });
    assert.ok(r.unavailable, 'and the report says UNVERIFIED rather than clean');
  } finally { sb.cleanup(); }
});

test('D8: probes are synthetic and the comparison never touches the real filesystem', () => {
  const sb = sandbox();
  try {
    fs.writeFileSync(globalPolicyPath(), SEALED_YAML);
    const sealed = parsePolicyFile(globalPolicyPath(), '/repo');
    const probes = probesFor([sealed], '/repo');
    assert.ok(probes.length > 0);
    for (const p of probes) {
      const f = p.action.filePath;
      if (f === undefined) continue;
      // Every probe path is under a root that exists on no machine, or is a synthetic leaf beneath
      // a rule the user wrote. None of them may be a path that could exist and be read: a check
      // that went to the disk to decide whether a directory is protected would itself be a way of
      // making usewarden touch something its own policy forbids (CLAUDE.md §1).
      assert.ok(f.includes('usewarden-probe') || f.includes('usewarden-probe-does-not-exist'),
        `probe path is not synthetic: ${f}`);
      assert.equal(fs.existsSync(f), false, `probe path must not exist on this machine: ${f}`);
    }
  } finally { sb.cleanup(); }
});

test('D9: the seal is written on first sight, and says what it is', () => {
  const sb = sandbox();
  try {
    fs.writeFileSync(globalPolicyPath(), SEALED_YAML);
    assert.equal(fs.existsSync(policySealMetaPath()), false, 'SETUP: no seal yet');
    const m = sealPolicy('first-observed');
    assert.ok(m);
    assert.equal(m.reason, 'first-observed',
      'an upgrade seal must not claim to be an install seal — it proves nothing about the days before it');
    assert.equal(fs.readFileSync(policySealPath(), 'utf8'), SEALED_YAML,
      'the seal is the policy VERBATIM, because a hash cannot be replayed');
  } finally { sb.cleanup(); }
});

test('D10: a reseal accepts the current rules as the new baseline', () => {
  const sb = sandbox();
  try {
    writePolicies(SEALED_YAML, WEAKENED_YAML);
    assert.ok(isWeaker(compareToSeal({ base: '/repo' })), 'SETUP: it must be weaker before the reseal');
    sealPolicy('reseal');
    const after = compareToSeal({ base: '/repo' });
    assert.equal(isWeaker(after), false, 'after a deliberate reseal there is nothing left to report');
    assert.equal(after.changed, false);
  } finally { sb.cleanup(); }
});
