import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { FIRING_GRACE_MS, firingFinding, type AgentStatus } from '../src/status.js';
import { sandbox, ev, type Sandbox } from './helpers.js';

/**
 * D-267: `usewarden doctor` — whose help text is "Diagnose why usewarden might not be firing" —
 * had six checks and not one of them asked whether anything had fired.
 *
 * Every other check reads a config file. All of them can pass while no hook has ever executed:
 * that is the EACCES defect in writeups/01-hook-not-running, where the entries were perfect,
 * `status` said PROTECTED, and every spawn died. When this was found, this repository's own state
 * had Codex CLI registered for ten days with zero events and doctor reporting PASS on every
 * Codex row.
 *
 * The verdict is deliberately THREE-VALUED. "Registered and silent" is not a failure — the user
 * may not have opened that agent — and it is not a pass either. It is UNVERIFIED, in the sense
 * CLAUDE.md §4.4 already uses. A tool that cries wolf about an agent you have not opened is a
 * tool people stop reading.
 */
const HOUR = 60 * 60 * 1000;

const agent = (firing: AgentStatus['firing'], label = 'Codex CLI'): { label: string; firing: AgentStatus['firing'] } =>
  ({ label, firing });

describe('firing evidence: registration is not evidence of execution', () => {
  let sb: Sandbox;
  let store: Store;
  beforeEach(() => { sb = sandbox(); store = new Store(); });
  afterEach(() => { store.close(); sb.cleanup(); });

  describe('the store can answer "how many times, and when"', () => {
    test('THE SETUP LANDS: an agent with no events really reports none', () => {
      assert.equal(store.eventStatsByAgent().size, 0, 'a fresh store must report no firing for anyone');
    });

    test('counts and last-seen are per agent, not global', () => {
      const now = Date.now();
      store.recordEvent(ev({ agent: 'claude', sessionId: 's1', ts: now - 3 * HOUR }), '/tmp/a');
      store.recordEvent(ev({ agent: 'claude', sessionId: 's1', ts: now - 1 * HOUR }), '/tmp/b');
      store.recordEvent(ev({ agent: 'gemini', sessionId: 's2', ts: now - 2 * HOUR }), '/tmp/c');

      const stats = store.eventStatsByAgent();
      assert.equal(stats.get('claude')?.count, 2);
      assert.equal(stats.get('gemini')?.count, 1);
      assert.equal(stats.get('codex'), undefined, 'an agent that never fired must be ABSENT, not zero-with-a-timestamp');
      // The whole point: a global count of 3 would hide that codex has never run.
      assert.equal(stats.get('claude')!.lastTs, now - 1 * HOUR, 'last-seen must be the most recent, not the first');
    });
  });

  describe('the doctor row', () => {
    const now = Date.now();

    test('an agent that has fired PASSES and says when', () => {
      const f = firingFinding(agent({ verdict: 'firing', events: 685, lastEventTs: now - 3 * HOUR, registeredAt: now - 10 * HOUR }), now);
      assert.equal(f.ok, true);
      assert.equal(f.unverified, undefined);
      assert.match(f.detail, /685 events recorded/);
      assert.match(f.detail, /3h ago/);
    });

    test('an agent registered MOMENTS ago is pending, not an alarm', () => {
      // The false alarm this avoids: every `usewarden init` is immediately followed by a status
      // check, and screaming about an agent the user has not had time to open would train them
      // to ignore the one row that matters.
      const f = firingFinding(agent({ verdict: 'pending', events: 0, lastEventTs: null, registeredAt: now - 60_000 }), now);
      assert.equal(f.ok, true);
      assert.equal(f.unverified, undefined);
      assert.match(f.detail, /normal this soon/);
    });

    test('an agent registered long ago with NO events is UNVERIFIED — not a pass, and not a failure', () => {
      const f = firingFinding(agent({ verdict: 'unverified', events: 0, lastEventTs: null, registeredAt: now - 10 * 24 * HOUR }), now);
      assert.equal(f.unverified, true, 'this is the defect shape and it must not be reported as PASS');
      assert.equal(f.ok, false, 'ok:false is what keeps it out of the green count');
      assert.match(f.detail, /NO EVENTS EVER/);
      assert.match(f.detail, /10d ago/);
    });

    test('the UNVERIFIED message states BOTH readings, because usewarden cannot tell them apart', () => {
      // Claiming "your hooks are broken" would be a false alarm; claiming "you just have not used
      // it" would be the silent-guardian failure. The honest output is both, and the action that
      // distinguishes them.
      const f = firingFinding(agent({ verdict: 'unverified', events: 0, lastEventTs: null, registeredAt: now - 5 * 24 * HOUR }), now);
      assert.match(f.detail, /have not used this agent/, 'must offer the benign reading');
      assert.match(f.detail, /not executing/, 'must offer the dangerous reading');
      assert.match(f.detail, /run any command in that agent/, 'must name the action that settles it');
    });

    test('a missing registration timestamp does not crash and does not silently pass', () => {
      const f = firingFinding(agent({ verdict: 'unverified', events: 0, lastEventTs: null, registeredAt: null }), now);
      assert.equal(f.unverified, true);
      assert.doesNotMatch(f.detail, /NaN|Invalid Date|undefined/);
    });
  });

  test('the grace window is a real duration, not zero and not a week', () => {
    // A named constant so the trade-off is reviewable rather than buried in an expression.
    assert.ok(FIRING_GRACE_MS >= HOUR, 'too short and every init raises an alarm about an unopened agent');
    assert.ok(FIRING_GRACE_MS <= 3 * 24 * HOUR, 'too long and a genuinely dead hook looks healthy for a working week');
  });
});
