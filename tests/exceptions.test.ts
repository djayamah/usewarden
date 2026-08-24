import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { Store } from '../src/store.js';
import { handleEvent } from '../src/engine/pipeline.js';
import { evaluateLayer1 } from '../src/engine/layer1.js';
import { loadPolicy } from '../src/policy/load.js';
import { defaultPolicy } from '../src/policy/schema.js';
import {
  DEFAULT_TTL_HOURS, addException, findException, loadExceptions, refuseIfNotHuman,
} from '../src/exceptions.js';
import { stripAnsi } from '../src/term.js';
import { clearGitStateCache } from '../src/engine/gitstate.js';
import { sandbox, gitInit, ev, type Sandbox } from './helpers.js';

/**
 * `usewarden allow` — the escape hatch.
 *
 * `docs/FALSE-POSITIVES.md` names the absence of one as the most likely reason someone removes this
 * tool. But an escape hatch is only safe if four things hold, and every test here is one of them:
 * it expires, it is not in the policy file, it is scoped to one rule in one project, and **the
 * agent cannot invoke it**. The last is the one the whole feature rests on.
 */
describe('allow: the escape hatch', () => {
  let sb: Sandbox;
  beforeEach(() => { sb = sandbox(); clearGitStateCache(); });
  afterEach(() => { sb.cleanup(); });

  const CLI = path.resolve('dist/src/cli.js');
  const run = (argv: string[], env: Record<string, string> = {}): { out: string; code: number } => {
    try {
      const out = execFileSync(process.execPath, [CLI, ...argv], {
        encoding: 'utf8', cwd: sb.repo,
        env: { ...process.env, USEWARDEN_HOME: sb.usewardenHome, NO_COLOR: '1', ...env },
      });
      return { out, code: 0 };
    } catch (err) {
      const e = err as { status: number; stdout: string; stderr: string };
      return { out: (e.stdout ?? '') + (e.stderr ?? ''), code: e.status };
    }
  };

  // ---------------------------------------------------------------------------------------
  // THE PROPERTY THE WHOLE FEATURE RESTS ON
  // ---------------------------------------------------------------------------------------

  test('SABOTAGE: an agent cannot grant itself a waiver', () => {
    // THE SABOTAGE LANDS: this is exactly how every supported agent runs a shell command - through
    // a captured pipe, with no controlling terminal. If that succeeded, the guardrail would ship
    // with a documented one-line bypass that a blocked agent is optimised to find.
    assert.notEqual(process.stdin.isTTY, true,
      'setup failed: this test process has a TTY, so it cannot stand in for an agent');

    const r = run(['allow', 'dotenv-access']);
    assert.equal(r.code, 3, 'a non-interactive caller must be refused with a distinct exit code');
    assert.match(r.out, /REFUSED/);
    assert.match(r.out, /not by an agent/);
    // And nothing was written. A refusal that still records the waiver is not a refusal.
    assert.equal(fs.existsSync(path.join(sb.usewardenHome, 'exceptions.json')), false,
      'a refused grant must not leave an exception on disk');
  });

  test('the guard is stdin-based, and the override is documented rather than hidden', () => {
    delete process.env['USEWARDEN_ALLOW_NONINTERACTIVE'];
    assert.ok(refuseIfNotHuman(), 'no TTY in the test runner, so it must refuse');
    process.env['USEWARDEN_ALLOW_NONINTERACTIVE'] = '1';
    assert.equal(refuseIfNotHuman(), null, 'the documented override must work');
    delete process.env['USEWARDEN_ALLOW_NONINTERACTIVE'];
  });

  // ---------------------------------------------------------------------------------------
  // It expires
  // ---------------------------------------------------------------------------------------

  test('the default is 24 hours, and an expired waiver stops applying', () => {
    const t0 = 1_000_000_000_000;
    addException('dotenv-access', sb.repo, DEFAULT_TTL_HOURS, undefined, t0);
    assert.equal(DEFAULT_TTL_HOURS, 24);

    const justBefore = loadExceptions(t0 + 23 * 3_600_000);
    assert.equal(justBefore.length, 1, 'still live at 23 hours');

    const justAfter = loadExceptions(t0 + 25 * 3_600_000);
    assert.equal(justAfter.length, 0, 'gone at 25 hours');
    // Expiry is enforced when the file is READ, not by a cleanup job that might never run.
    assert.ok(fs.existsSync(path.join(sb.usewardenHome, 'exceptions.json')),
      'the row may remain on disk; what matters is that it is not returned');
  });

  test('it is NOT written into the policy file, so it cannot become permanent by being committed', () => {
    addException('dotenv-access', sb.repo);
    const policyFiles = [
      path.join(sb.usewardenHome, 'usewarden.yaml'),
      path.join(sb.repo, 'usewarden.yaml'),
    ];
    for (const f of policyFiles) {
      if (!fs.existsSync(f)) continue;
      assert.ok(!fs.readFileSync(f, 'utf8').includes('dotenv-access'),
        `${f} must not carry the waiver - a policy file gets committed and shared`);
    }
    assert.ok(fs.existsSync(path.join(sb.usewardenHome, 'exceptions.json')));
  });

  // ---------------------------------------------------------------------------------------
  // It is scoped
  // ---------------------------------------------------------------------------------------

  test('a waiver in one project does not open the rule everywhere on the machine', () => {
    addException('dotenv-access', sb.repo);
    const live = loadExceptions();
    assert.ok(findException('dotenv-access', sb.repo, live), 'applies in the project it was granted in');
    assert.equal(findException('dotenv-access', path.join(sb.root, 'other-project'), live), null,
      'must NOT apply in a different project');
  });

  test('the id can be typed as it appears on the card, or as the bare rule name', () => {
    // The card prints `commands.deny[6] (dotenv-access)`. Asking someone to retype that correctly
    // mid-task is asking them to give up.
    addException('dotenv-access', sb.repo);
    const live = loadExceptions();
    assert.ok(findException('commands.deny[6] (dotenv-access)', sb.repo, live));
    assert.ok(findException('dotenv-access', sb.repo, live));
    assert.equal(findException('sudo', sb.repo, live), null);
  });

  // ---------------------------------------------------------------------------------------
  // A waiver changes the verdict, never the audit trail
  // ---------------------------------------------------------------------------------------

  test('THE BLOCK LANDS FIRST: without a waiver the .env read is denied', async () => {
    gitInit(sb.repo);
    fs.writeFileSync(path.join(sb.repo, '.env'), 'TOKEN=x\n');
    const s = new Store(path.join(sb.usewardenHome, 'usewarden.db'));
    const res = await handleEvent(s, ev({
      tool: 'read', rawTool: 'Read', filePath: path.join(sb.repo, '.env'), cwd: sb.repo,
    }), { live: true, origin: 'live', loaded: loadPolicy(sb.repo), noJudge: true });
    assert.equal(res.verdict.decision, 'deny', 'setup failed: the rule did not fire');
    s.close();
  });

  test('with a waiver it is ALLOWED, and still recorded as an incident', async () => {
    gitInit(sb.repo);
    fs.writeFileSync(path.join(sb.repo, '.env'), 'TOKEN=x\n');
    addException('scope.forbidden_paths', sb.repo);

    const s = new Store(path.join(sb.usewardenHome, 'usewarden.db'));
    const res = await handleEvent(s, ev({
      tool: 'read', rawTool: 'Read', filePath: path.join(sb.repo, '.env'), cwd: sb.repo,
    }), { live: true, origin: 'live', loaded: loadPolicy(sb.repo), noJudge: true });

    assert.equal(res.verdict.decision, 'allow', 'the waiver must let it through');
    assert.equal(res.verdict.severity, 'warn', 'and must NOT be silent about it');
    assert.match(res.verdict.reason, /WAIVED by/);
    assert.match(res.verdict.reason, /would have been blocked/);

    // The audit trail is the point. A waiver changes the verdict, not the record.
    const rows = s.recentIncidents();
    assert.equal(rows.length, 1, 'a waived block is still an incident');
    assert.match(rows[0]!.title, /Waived by an explicit human exception/);
    assert.equal(rows[0]!.action, 'warn');
    s.close();
  });

  test('an expired waiver does not let anything through', () => {
    const t0 = 1_000_000_000_000;
    addException('scope.forbidden_paths', sb.repo, DEFAULT_TTL_HOURS, undefined, t0);
    const stale = loadExceptions(t0 + 25 * 3_600_000);
    const v = evaluateLayer1(
      ev({ tool: 'read', filePath: path.join(sb.repo, '.env'), cwd: sb.repo }),
      { policy: defaultPolicy(sb.repo), repoRoot: sb.repo, exceptions: stale },
    );
    assert.equal(v.decision, 'deny', 'an expired waiver must not apply');
  });

  test('a waiver on ONE rule does not waive a different one', () => {
    addException('dotenv-access', sb.repo);
    const v = evaluateLayer1(
      ev({ tool: 'bash', command: 'sudo rm /etc/hosts', cwd: sb.repo }),
      { policy: defaultPolicy(sb.repo), repoRoot: sb.repo, exceptions: loadExceptions() },
    );
    assert.equal(v.decision, 'deny', 'the sudo rule is untouched by a dotenv waiver');
  });

  // ---------------------------------------------------------------------------------------
  // The surfaces
  // ---------------------------------------------------------------------------------------

  test('grant, list and revoke work for a human, and --json mirrors them', () => {
    const H = { USEWARDEN_ALLOW_NONINTERACTIVE: '1' };

    const empty = run(['allow', '--list'], H);
    assert.match(empty.out, /No waivers are active/);

    const granted = run(['allow', 'dotenv-access'], H);
    assert.equal(granted.code, 0);
    assert.match(granted.out, /WAIVED/);
    assert.match(granted.out, /expires in 24 hours/);
    assert.match(granted.out, /still recorded/);

    const listed = run(['allow', '--list'], H);
    assert.match(listed.out, /dotenv-access/);
    assert.match(listed.out, /left/);

    const asJson = JSON.parse(run(['allow', '--list', '--json'], H).out) as
      { exceptions: { rule: string; expiresAt: number }[] };
    assert.equal(asJson.exceptions.length, 1);
    assert.equal(asJson.exceptions[0]!.rule, 'dotenv-access');

    const revoked = run(['allow', '--revoke', 'dotenv-access'], H);
    assert.match(revoked.out, /Revoked/);
    assert.match(run(['allow', '--list'], H).out, /No waivers are active/);
  });

  test('no rule id is a usage error, not a silent no-op', () => {
    const r = run(['allow'], { USEWARDEN_ALLOW_NONINTERACTIVE: '1' });
    assert.equal(r.code, 2);
    assert.match(stripAnsi(r.out), /needs a rule id/);
  });

  test('revoking something that was never granted says so rather than claiming success', () => {
    const r = run(['allow', '--revoke', 'never-granted'], { USEWARDEN_ALLOW_NONINTERACTIVE: '1' });
    assert.match(r.out, /No active waiver/);
    assert.match(r.out, /Nothing changed/);
  });
});

describe('allow: which typed id covers which verdict', () => {
  test('every form a card can print is coverable by something a human would type', async () => {
    const { ruleMatches } = await import('../src/exceptions.js');
    // Exact.
    assert.equal(ruleMatches('commands.deny[6] (dotenv-access)', 'commands.deny[6] (dotenv-access)'), true);
    // The name, which is what a human reads and remembers.
    assert.equal(ruleMatches('dotenv-access', 'commands.deny[6] (dotenv-access)'), true);
    // The section, for an indexed rule with no name. This is the case the first end-to-end test
    // caught: the waiver looked granted and did nothing.
    assert.equal(ruleMatches('scope.forbidden_paths', 'scope.forbidden_paths[11]'), true);
    assert.equal(ruleMatches('scope.protect_uncommitted', 'scope.protect_uncommitted (untracked)'), true);
    // NOT a prefix test - a partial name must not waive a whole section.
    assert.equal(ruleMatches('scope.forbidden', 'scope.forbidden_paths[11]'), false);
    assert.equal(ruleMatches('scope', 'scope.allowed_paths'), false);
    assert.equal(ruleMatches('dotenv', 'commands.deny[6] (dotenv-access)'), false);
  });
});
