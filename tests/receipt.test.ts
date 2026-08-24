import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { Store } from '../src/store.js';
import { handleEvent } from '../src/engine/pipeline.js';
import { loadPolicy } from '../src/policy/load.js';
import {
  buildReceipt, latestSessionId, recentSessionIds, receiptJson, renderReceipt,
  renderReceiptLine, renderNoSession, receiptStatusLine, humanDuration, idleGapMs,
} from '../src/receipt.js';
import { stripAnsi } from '../src/term.js';
import { clearGitStateCache } from '../src/engine/gitstate.js';
import { sandbox, gitInit, ev, type Sandbox } from './helpers.js';

/**
 * SESSION RECEIPTS.
 *
 * The rule that governs every test here: **a clean session is the normal case, and the receipt for
 * one must be complete.** Blank, sparse, or "nothing to report" for a session where nothing was
 * blocked is the failure this feature exists to prevent, not an edge case it may fall into. Most
 * of the file is therefore about the boring session rather than the exciting one.
 *
 * The second rule: nothing here may depend on a session-end hook having fired. OpenCode exposes no
 * session lifecycle event at all, and the five agents that document one do not fire it when the
 * process is killed.
 */
describe('session receipts', () => {
  let sb: Sandbox;
  beforeEach(() => { sb = sandbox(); clearGitStateCache(); });
  afterEach(() => { sb.cleanup(); });

  const store = (): Store => new Store(path.join(sb.usewardenHome, 'usewarden.db'));

  /** Runs a small, entirely ordinary session: some reads, some edits, some commands. */
  async function cleanSession(s: Store, sessionId = 'clean-1', t0 = 1_000_000): Promise<void> {
    // gitInit commits, and committing twice in the same repo fails with "nothing to commit" -
    // which surfaced as a confusing git error the first time this file ran two sessions.
    if (!fs.existsSync(path.join(sb.repo, '.git'))) gitInit(sb.repo);
    const loaded = loadPolicy(sb.repo);
    const send = async (o: Record<string, unknown>, dt: number): Promise<void> => {
      await handleEvent(s, ev({ sessionId, cwd: sb.repo, ts: t0 + dt, ...o } as never),
        { live: true, origin: 'live', loaded, noJudge: true });
    };
    await send({ event: 'session_start' }, 0);
    await send({ event: 'user_prompt', prompt: 'add pagination to the todo list' }, 100);
    await send({ tool: 'read', rawTool: 'Read', filePath: path.join(sb.repo, 'README.md') }, 1000);
    await send({ tool: 'bash', rawTool: 'Bash', command: 'npm test' }, 2000);
    await send({ tool: 'edit', rawTool: 'Edit', filePath: path.join(sb.repo, 'README.md') }, 3000);
    await send({ tool: 'write', rawTool: 'Write', filePath: path.join(sb.repo, 'src', 'page.ts') }, 4000);
    await send({ tool: 'bash', rawTool: 'Bash', command: 'git add -A' }, 5000);
    await send({ tool: 'bash', rawTool: 'Bash', command: 'git commit -m "feat: pagination"' }, 6000);
  }

  // ---------------------------------------------------------------------------------------
  // THE HARD REQUIREMENT
  // ---------------------------------------------------------------------------------------

  test('THE SETUP LANDS: the clean session really did produce events and NO incidents', async () => {
    const s = store();
    await cleanSession(s);
    const events = s.db.prepare('SELECT COUNT(*) AS n FROM events WHERE session_id=?').get('clean-1') as { n: number };
    const incs = s.db.prepare('SELECT COUNT(*) AS n FROM incidents WHERE session_id=?').get('clean-1') as { n: number };
    assert.equal(Number(events.n), 8, 'setup failed: the session did not record 8 events');
    assert.equal(Number(incs.n), 0, 'setup failed: a clean session must have no incidents');
    s.close();
  });

  test('A ZERO-INCIDENT SESSION YIELDS A FULLY POPULATED RECEIPT — every field, no blanks', async () => {
    const s = store();
    await cleanSession(s);
    const r = buildReceipt(s, 'clean-1', 1_000_000 + 7000)!;
    assert.ok(r, 'a receipt must exist for a clean session');

    // Identity and scope.
    assert.equal(r.sessionId, 'clean-1');
    assert.equal(r.agent, 'claude');
    assert.equal(r.origin, 'live');
    assert.equal(r.cwd, sb.repo);
    assert.equal(r.goal, 'add pagination to the todo list');

    // Time.
    assert.equal(typeof r.startedAt, 'number');
    assert.ok(r.startedAt > 0);
    assert.equal(r.durationMs.available, true, 'duration must be available');
    assert.ok((r.durationMs as { value: number }).value >= 6000);

    // Work done — these are the fields a clean session is entirely made of.
    assert.equal(r.events, 8);
    assert.equal(r.filesTouched.available, true);
    assert.equal((r.filesTouched as { value: number }).value, 2, 'README.md and src/page.ts');
    assert.equal(r.commandsRun.available, true);
    assert.equal((r.commandsRun as { value: number }).value, 3);

    // Genuinely zero, and printed as zero rather than as absent.
    assert.equal(r.blocked, 0);
    assert.equal(r.warned, 0);
    assert.equal(r.outsideScope, 0);

    // Not knowable here, and therefore NOT zero.
    assert.equal(r.peakContextFill.available, false);
    assert.match((r.peakContextFill as { reason: string }).reason, /context fill/);
    assert.equal(r.judge.available, true, 'a fresh v3 database can attribute judge spend');
    assert.equal((r.judge as { value: { calls: number } }).value.calls, 0);

    assert.deepEqual(r.problems, [], 'the arithmetic must check out');
    s.close();
  });

  test('...and it RENDERS every field, with a sentence saying zero is the answer', async () => {
    const s = store();
    await cleanSession(s);
    const text = stripAnsi(renderReceipt(buildReceipt(s, 'clean-1', 1_000_000 + 7000)!));

    for (const field of ['session', 'boundary', 'project', 'goal', 'did', 'caught', 'context', 'guardian']) {
      assert.match(text, new RegExp(`^\\s+${field}\\s`, 'm'), `the "${field}" row is missing`);
    }
    assert.match(text, /8 events/);
    assert.match(text, /2 files touched/);
    assert.match(text, /3 commands run/);
    assert.match(text, /0 blocked · 0 warned · 0 outside scope/);
    // The clean-session sentence. Without it a receipt of zeros reads as a broken tool.
    assert.match(text, /Nothing needed blocking this session/);
    assert.match(text, /8 events were inspected against your policy/);
    assert.ok(!/nothing to report/i.test(text), 'a clean session must never say "nothing to report"');
    s.close();
  });

  test('no rendered line exceeds the width budget, and NO_COLOR loses no information', async () => {
    const s = store();
    await cleanSession(s);
    const r = buildReceipt(s, 'clean-1', 1_000_000 + 7000)!;
    const rendered = renderReceipt(r);
    const widest = Math.max(...rendered.split('\n').map((l) => stripAnsi(l).length));
    assert.ok(widest <= 84, `widest line is ${widest}, budget is 84`);
    // Colour is decoration here: every fact survives stripping it.
    const plain = stripAnsi(rendered);
    assert.match(plain, /0 blocked/);
    assert.match(plain, /Nothing needed blocking/);
    s.close();
  });

  test('--json mirrors the human form exactly, including unavailability AND its reason', async () => {
    const s = store();
    await cleanSession(s);
    const j = receiptJson(buildReceipt(s, 'clean-1', 1_000_000 + 7000)!) as Record<string, never>;
    assert.equal(j['events'], 8);
    assert.equal(j['blocked'], 0);
    assert.deepEqual(j['files_touched'], { available: true, value: 2 });
    const ctx = j['peak_context_fill'] as unknown as { available: boolean; reason: string };
    assert.equal(ctx.available, false);
    assert.ok(ctx.reason.length > 0, 'an unavailable field must carry its reason into JSON too');
    assert.ok(!('value' in ctx), 'an unavailable field must not carry a value, not even zero');
    for (const k of ['session_id', 'agent', 'origin', 'cwd', 'goal', 'started_at', 'boundary_method',
      'duration_ms', 'commands_run', 'outside_scope', 'warned', 'judge', 'problems']) {
      assert.ok(k in j, `--json is missing ${k}`);
    }
    s.close();
  });

  // ---------------------------------------------------------------------------------------
  // BOUNDARY DETERMINATION — the hook is evidence, never a dependency
  // ---------------------------------------------------------------------------------------

  test('a session_end hook is used when it fired, and named as the method', async () => {
    const s = store();
    await cleanSession(s);
    await handleEvent(s, ev({ sessionId: 'clean-1', cwd: sb.repo, event: 'session_end', ts: 1_007_000 }),
      { live: true, origin: 'live', loaded: loadPolicy(sb.repo), noJudge: true });
    const r = buildReceipt(s, 'clean-1', 1_100_000)!;
    assert.equal(r.boundary.method, 'session-end-hook');
    assert.equal(r.endedAt, 1_007_000);
    assert.match(stripAnsi(renderReceipt(r)), /session-end-hook/);
    s.close();
  });

  test('SABOTAGE: delete the session-boundary hook event — the receipt still derives', async () => {
    const s = store();
    await cleanSession(s);
    await handleEvent(s, ev({ sessionId: 'clean-1', cwd: sb.repo, event: 'session_end', ts: 1_007_000 }),
      { live: true, origin: 'live', loaded: loadPolicy(sb.repo), noJudge: true });

    // THE SABOTAGE LANDS: assert the boundary event really is there before removing it.
    const before = s.db.prepare(
      `SELECT COUNT(*) AS n FROM events WHERE session_id=? AND event='session_end'`).get('clean-1') as { n: number };
    assert.equal(Number(before.n), 1, 'setup failed: there was no session_end event to delete');
    s.db.exec(`DELETE FROM events WHERE session_id='clean-1' AND event='session_end'`);
    const after = s.db.prepare(
      `SELECT COUNT(*) AS n FROM events WHERE session_id=? AND event='session_end'`).get('clean-1') as { n: number };
    assert.equal(Number(after.n), 0, 'the sabotage did not land');

    // Long after the last event, so the idle gap has elapsed.
    const r = buildReceipt(s, 'clean-1', 1_006_000 + idleGapMs() + 60_000)!;
    assert.ok(r, 'a receipt must still exist with no boundary hook');
    assert.equal(r.boundary.method, 'idle-gap');
    assert.equal(r.endedAt, 1_006_000, 'the last real event becomes the end');
    assert.equal(r.durationMs.available, true);
    // Everything else is unchanged: the hook was evidence, not a dependency.
    assert.equal(r.events, 8, 'the 8 ordinary events survive; only the boundary event was removed');
    assert.equal(r.filesTouched.available, true);
    assert.equal((r.filesTouched as { value: number }).value, 2);
    assert.match(stripAnsi(renderReceipt(r)), /no session-end hook; silent for over \d+m/);
    s.close();
  });

  test('a session still inside the idle gap is reported as in-progress, not as ended', async () => {
    const s = store();
    await cleanSession(s);
    const r = buildReceipt(s, 'clean-1', 1_006_000 + 60_000)!;
    assert.equal(r.boundary.method, 'in-progress');
    assert.equal(r.endedAt, null);
    assert.equal(r.durationMs.available, true, 'a running session still reports elapsed time');
    assert.match(stripAnsi(renderReceipt(r)), /still active/);
    s.close();
  });

  // ---------------------------------------------------------------------------------------
  // SABOTAGE: corruption must cost its own field, and never become a zero
  // ---------------------------------------------------------------------------------------

  test('SABOTAGE: corrupt one event row — the affected field says unavailable, never zero', async () => {
    const s = store();
    await cleanSession(s);

    // THE SABOTAGE LANDS: the row really is a countable file event before it is broken.
    const target = path.join(sb.repo, 'src', 'page.ts');
    const before = s.db.prepare(
      `SELECT COUNT(*) AS n FROM events WHERE session_id=? AND target=? AND tool='write'`)
      .get('clean-1', target) as { n: number };
    assert.equal(Number(before.n), 1, 'setup failed: the write event is not there to corrupt');

    s.db.prepare(`UPDATE events SET target=NULL WHERE session_id=? AND target=?`).run('clean-1', target);
    const after = s.db.prepare(
      `SELECT COUNT(*) AS n FROM events WHERE session_id=? AND tool='write' AND target IS NULL`)
      .get('clean-1') as { n: number };
    assert.equal(Number(after.n), 1, 'the sabotage did not land');

    const r = buildReceipt(s, 'clean-1', 1_000_000 + 7000)!;
    assert.equal(r.filesTouched.available, false, 'the corrupted field must not report a number');
    assert.match((r.filesTouched as { reason: string }).reason, /no recorded target/);
    // The neighbouring fields are untouched. Corruption costs its own field and no more.
    assert.equal(r.commandsRun.available, true);
    assert.equal((r.commandsRun as { value: number }).value, 3);
    assert.equal(r.events, 8);
    assert.ok(r.problems.length > 0, 'the problem must be surfaced, not swallowed');

    const text = stripAnsi(renderReceipt(r));
    assert.match(text, /unavailable/);
    assert.ok(!/0 files touched/.test(text), 'a corrupted count must NEVER render as zero');
    assert.match(text, /THESE FIGURES DO NOT ADD UP/);
    s.close();
  });

  test('SABOTAGE: corrupt a timestamp — duration reports unavailable rather than a wrong number', async () => {
    const s = store();
    await cleanSession(s);
    const before = s.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE session_id=? AND ts>0`).get('clean-1') as { n: number };
    assert.equal(Number(before.n), 8, 'setup failed');
    s.db.exec(`UPDATE events SET ts=-1 WHERE session_id='clean-1' AND event='session_start'`);
    const after = s.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE session_id=? AND ts<0`).get('clean-1') as { n: number };
    assert.equal(Number(after.n), 1, 'the sabotage did not land');

    const r = buildReceipt(s, 'clean-1', 1_000_000 + 7000)!;
    assert.equal(r.durationMs.available, false);
    assert.match((r.durationMs as { reason: string }).reason, /unusable timestamp/);
    assert.ok(r.problems.some((p) => /unusable timestamp/.test(p)));
    s.close();
  });

  // ---------------------------------------------------------------------------------------
  // SABOTAGE: nothing at all must be LOUD, and must not resemble a clean session
  // ---------------------------------------------------------------------------------------

  test('SABOTAGE: no session at all — loud, and clearly NOT a clean session', () => {
    const s = store();
    assert.equal(latestSessionId(s), null, 'setup failed: the store already has a session');
    assert.deepEqual(recentSessionIds(s), []);

    const text = stripAnsi(renderNoSession('usewarden has no session recorded in this database.'));
    assert.match(text, /NO SESSION FOUND/);
    // The distinguishing sentence: this is the failure a clean receipt is most likely confused with.
    assert.match(text, /NOT the same as a session in which nothing was blocked/);
    assert.match(text, /usewarden status/);
    assert.ok(!/Nothing needed blocking/.test(text),
      'the empty state must not borrow the clean-session sentence');
    s.close();
  });

  test('a session row with no events is still a receipt, and says so rather than showing zeros', () => {
    const s = store();
    s.upsertSession('ghost', 'claude', sb.repo, 5_000, 'live');
    const r = buildReceipt(s, 'ghost', 5_000)!;
    assert.ok(r, 'a session with no events still has a receipt');
    assert.equal(r.events, 0);
    assert.equal(r.peakContextFill.available, false);
    assert.match((r.peakContextFill as { reason: string }).reason, /recorded no events/);
    s.close();
  });

  // ---------------------------------------------------------------------------------------
  // Derived, never counted
  // ---------------------------------------------------------------------------------------

  test('the figures are DERIVED: a forged stored counter changes nothing on the receipt', async () => {
    const s = store();
    await cleanSession(s);
    // docs/METRICS.md: every figure computed by query at read time. These columns exist and the
    // receipt must not read them - SAB-20 applied to this surface.
    s.db.exec(`UPDATE sessions SET event_count=999999, judge_calls=4242, judge_cost=99.99 WHERE id='clean-1'`);
    s.bump('actions_blocked', 999999);
    const r = buildReceipt(s, 'clean-1', 1_000_000 + 7000)!;
    assert.equal(r.events, 8, 'events must come from the events table, not sessions.event_count');
    assert.equal(r.blocked, 0, 'blocked must come from incidents, not from a counter');
    assert.equal((r.judge as { value: { calls: number } }).value.calls, 0,
      'judge calls must come from judge_spend, not sessions.judge_calls');
    s.close();
  });

  test('blocked and warned are counted from real incidents when there ARE some', async () => {
    const s = store();
    gitInit(sb.repo);
    const loaded = loadPolicy(sb.repo);
    await handleEvent(s, ev({ sessionId: 'dirty-1', cwd: sb.repo, event: 'session_start', ts: 2_000_000 }),
      { live: true, origin: 'live', loaded, noJudge: true });
    await handleEvent(s, ev({
      sessionId: 'dirty-1', cwd: sb.repo, tool: 'read', rawTool: 'Read',
      filePath: path.join(sb.repo, '.env'), ts: 2_001_000,
    }), { live: true, origin: 'live', loaded, noJudge: true });

    const r = buildReceipt(s, 'dirty-1', 2_002_000)!;
    assert.equal(r.blocked, 1);
    assert.equal(r.warned, 0);
    assert.ok(r.outsideScope >= 1, 'a forbidden-path block is a scope rule');
    const text = stripAnsi(renderReceipt(r));
    assert.match(text, /1 blocked/);
    assert.match(text, /usewarden incidents/);
    assert.ok(!/Nothing needed blocking/.test(text));
    s.close();
  });

  // ---------------------------------------------------------------------------------------
  // The other two surfaces
  // ---------------------------------------------------------------------------------------

  test('the one-line forms are one line, and carry the session', async () => {
    const s = store();
    await cleanSession(s);
    const r = buildReceipt(s, 'clean-1', 1_000_000 + 7000)!;
    for (const line of [renderReceiptLine(r), receiptStatusLine(r)]) {
      assert.equal(line.includes('\n'), false, 'must be a single line');
      assert.ok(stripAnsi(line).length <= 84);
    }
    assert.match(stripAnsi(receiptStatusLine(r)), /8 ev · 0b 0w/);
    s.close();
  });

  test('sessions are listed most-recently-ACTIVE first', async () => {
    const s = store();
    await cleanSession(s, 'older', 1_000_000);
    await cleanSession(s, 'newer', 9_000_000);
    assert.deepEqual(recentSessionIds(s, 5).slice(0, 2), ['newer', 'older']);
    assert.equal(latestSessionId(s), 'newer');
    s.close();
  });

  test('humanDuration reads like a duration at every scale', () => {
    assert.equal(humanDuration(400), '400ms');
    assert.equal(humanDuration(4_000), '4s');
    assert.equal(humanDuration(125_000), '2m 5s');
    assert.equal(humanDuration(7_500_000), '2h 5m');
  });
});

describe('receipt: the CLI surfaces', () => {
  let sb: Sandbox;
  beforeEach(() => { sb = sandbox(); });
  afterEach(() => { sb.cleanup(); });

  const CLI = path.resolve('dist/src/cli.js');

  test('`usewarden last` on an empty database exits non-zero and says NO SESSION FOUND', async () => {
    const { execFileSync } = await import('node:child_process');
    const home = path.join(sb.root, 'empty-home');
    fs.mkdirSync(home, { recursive: true });
    let out = ''; let code = 0;
    try {
      out = execFileSync(process.execPath, [CLI, 'last'], {
        encoding: 'utf8', env: { ...process.env, USEWARDEN_HOME: home, NO_COLOR: '1' },
      });
    } catch (err) {
      const e = err as { status: number; stdout: string };
      code = e.status; out = e.stdout;
    }
    assert.notEqual(code, 0, 'an absent session must be a non-zero exit, not a quiet success');
    assert.match(out, /NO SESSION FOUND/);
    assert.match(out, /NOT the same as a session in which nothing was blocked/);
  });
});

describe('receipt: the dead capability it found', () => {
  test('NO adapter populates contextFill, so the receipt must say so exactly', async () => {
    // THE FINDING LANDS: assert the absence rather than describing it. `contextFill` appears in
    // types.ts, in the Layer-1 rule that consumes it, and in tests - and in no adapter.
    const fs2 = await import('node:fs');
    const dir = path.resolve('src/adapters');
    const setters: string[] = [];
    for (const f of fs2.readdirSync(dir)) {
      if (!f.endsWith('.ts')) continue;
      const src = fs2.readFileSync(path.join(dir, f), 'utf8');
      if (/contextFill\s*[:=]/.test(src)) setters.push(f);
    }
    assert.deepEqual(setters, [],
      `an adapter now sets contextFill (${setters.join(', ')}). That is GOOD NEWS: delete this `
      + 'test, restore the softer wording in receipt.ts, and update the README limitation and D-224 '
      + 'together.');
  });
});
