import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { Store } from '../src/store.js';
import { handleEvent } from '../src/engine/pipeline.js';
import { loadPolicy } from '../src/policy/load.js';
import { buildWeek, renderWeek } from '../src/week.js';
import { stripAnsi } from '../src/term.js';
import { clearGitStateCache } from '../src/engine/gitstate.js';
import { sandbox, gitInit, ev, type Sandbox } from './helpers.js';

/**
 * `usewarden week` — AND THE THREE OUTCOMES THAT MUST NEVER LOOK ALIKE.
 *
 * This command exists because the record was the only thing usewarden had that Claude Code's own
 * deny rules and OS sandbox do not (docs/RETENTION.md §2), and nothing surfaced it. The risk in a
 * summary command is not that it crashes; it is that it flatters.
 *
 * CLAUDE.md §4.4: "a control whose state could not be checked is reported as UNVERIFIED and counted
 * against the total. 'I could not tell' and 'it is fine' are different sentences." Applied here:
 *
 *   no sessions recorded  ->  usewarden may not be watching. A QUESTION, never a clean bill.
 *   sessions, no blocks   ->  a genuinely quiet week.
 *   sessions with blocks  ->  what was caught, grouped by the rule a human can act on.
 *
 * The demo test is the one that matters most. `usewarden demo` manufactures four blocked incidents
 * on demand; if those could leak into "what your agents did this week", the headline number would
 * be inflated by a feature whose entire purpose is to be synthetic — which is the exact failure
 * `origin` was introduced to prevent, and the exact failure that made a clean install once report
 * twelve blocked actions.
 */
describe('usewarden week', () => {
  let sb: Sandbox;
  beforeEach(() => { sb = sandbox(); clearGitStateCache(); });
  afterEach(() => { sb.cleanup(); });

  const store = (): Store => new Store(path.join(sb.usewardenHome, 'usewarden.db'));
  const NOW = 2_000_000_000_000;
  const DAY = 86_400_000;

  async function session(
    s: Store, sessionId: string, at: number,
    opts: { origin?: 'live' | 'demo' | 'fixture'; block?: boolean } = {},
  ): Promise<void> {
    if (!fs.existsSync(path.join(sb.repo, '.git'))) gitInit(sb.repo);
    const loaded = loadPolicy(sb.repo);
    const origin = opts.origin ?? 'live';
    const send = async (o: Record<string, unknown>, dt: number): Promise<void> => {
      await handleEvent(s, ev({ sessionId, cwd: sb.repo, ts: at + dt, ...o } as never),
        { live: origin === 'live', origin, loaded, noJudge: true });
    };
    await send({ event: 'session_start' }, 0);
    await send({ tool: 'read', rawTool: 'Read', filePath: path.join(sb.repo, 'README.md') }, 10);
    if (opts.block) {
      await send({ tool: 'bash', rawTool: 'Bash', command: 'sudo rm -rf /etc' }, 20);
    }
  }

  test('nothing recorded is reported as a QUESTION, not as a quiet week', () => {
    const s = store();
    try {
      const w = buildWeek(s, 7, NOW);
      // PRECONDITION: the database really is empty of live sessions.
      assert.equal(w.sessions, 0, 'setup failed: expected no sessions');
      assert.equal(w.nothingRecorded, true);

      const out = stripAnsi(renderWeek(w));
      assert.match(out, /No agent sessions were recorded/);
      assert.match(out, /usewarden status/,
        'must point at the command that answers whether it is watching');
      assert.doesNotMatch(out, /Nothing was blocked/,
        'an empty database must never render as the all-clear message');
    } finally { s.close(); }
  });

  test('a quiet week says so plainly, and is NOT the same message as an empty one', async () => {
    const s = store();
    try {
      await session(s, 'quiet-1', NOW - 2 * DAY);
      const w = buildWeek(s, 7, NOW);
      // PRECONDITION: a real session exists and it blocked nothing.
      assert.equal(w.sessions, 1, 'setup failed: the live session was not picked up');
      assert.equal(w.blocked, 0, 'setup failed: the quiet session should have blocked nothing');
      assert.equal(w.nothingRecorded, false);

      const out = stripAnsi(renderWeek(w));
      assert.match(out, /Nothing was blocked/);
      assert.doesNotMatch(out, /No agent sessions were recorded/);
    } finally { s.close(); }
  });

  test('DEMO AND FIXTURE SESSIONS ARE NOT "WHAT YOUR AGENTS DID"', async () => {
    const s = store();
    try {
      await session(s, 'demo-1', NOW - DAY, { origin: 'demo', block: true });
      await session(s, 'fix-1', NOW - DAY, { origin: 'fixture', block: true });

      // PRECONDITION: those sessions really did record blocked incidents. Without this the test
      // would pass just as well against a store where nothing was written at all.
      const inc = s.db.prepare('SELECT COUNT(*) AS n FROM incidents').get() as { n: number };
      assert.ok(Number(inc.n) >= 2,
        `setup failed: expected demo+fixture incidents, found ${inc.n}`);

      const w = buildWeek(s, 7, NOW);
      assert.equal(w.sessions, 0, 'a demo or fixture session was counted as real agent activity');
      assert.equal(w.blocked, 0, 'demo incidents inflated the blocked count');
      assert.equal(w.nothingRecorded, true);
    } finally { s.close(); }
  });

  test('blocks are grouped by rule, which is the part a human can act on', async () => {
    const s = store();
    try {
      await session(s, 'busy-1', NOW - DAY, { block: true });
      const w = buildWeek(s, 7, NOW);
      // PRECONDITION: the block landed.
      assert.ok(w.blocked > 0, 'setup failed: the sabotage command was not blocked');
      assert.ok(w.byRule.length > 0, 'blocks were counted but no rule was attributed');

      const out = stripAnsi(renderWeek(w));
      assert.match(out, /blocked/);
      assert.match(out, new RegExp(w.byRule[0]!.rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        'the top rule is not named in the output');
    } finally { s.close(); }
  });

  test('the window is honoured: an older session is outside "the last 7 days"', async () => {
    const s = store();
    try {
      await session(s, 'old-1', NOW - 30 * DAY, { block: true });
      // PRECONDITION: it is in the database at all.
      assert.equal(buildWeek(s, 90, NOW).sessions, 1, 'setup failed: the old session was not recorded');
      assert.equal(buildWeek(s, 7, NOW).sessions, 0, 'a 30-day-old session leaked into a 7-day window');
    } finally { s.close(); }
  });
});
