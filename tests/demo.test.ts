import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { sandbox } from './helpers.js';

/**
 * `usewarden demo` — THE CARDS IT PRINTS MUST BE THE CARDS IT EVALUATED.
 *
 * The demo is the first thing a new user runs and the only incident card most of them will see
 * before deciding whether to keep the tool. It ran four scenarios, blocked all four, correctly
 * reported "All 4 demo violations were blocked" — and printed the curl-pipe-shell card TWICE,
 * because it rendered each card by asking the store for "the newest demo incident" instead of for
 * the incident it had just written.
 *
 * `ts` is millisecond-granular and all four scenarios are evaluated inside the same millisecond,
 * so `ORDER BY ts DESC LIMIT 1` was choosing among four rows SQLite considers equal, in an order
 * it explicitly does not define. The summary line read from `results`, which was right, so the
 * count and the cards disagreed and only the cards were wrong. That is the failure mode worth
 * pinning: a surface that looks authoritative while showing something that did not happen.
 *
 * The test asserts the PRECONDITION first — that four genuinely distinct rules fire — because a
 * version of this test that only counted distinct cards would pass just as happily if the demo
 * silently stopped running the fourth scenario.
 */
describe('demo: every scenario shows its own card', () => {
  const CLI = path.resolve('dist/src/cli.js');

  function demo(args: string[], home: string): string {
    return execFileSync(process.execPath, [CLI, 'demo', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home, NO_COLOR: '1' },
    });
  }

  test('all four scenarios are blocked, by four DIFFERENT rules', () => {
    const sb = sandbox();
    try {
      const out = JSON.parse(demo(['--json'], sb.root)) as {
        scenarios: { scenario: string; decision: string; rule?: string }[];
        caught: number; total: number;
      };
      assert.equal(out.total, 4, 'the demo no longer runs four scenarios');
      assert.equal(out.caught, 4, 'the demo no longer blocks all four');
      for (const s of out.scenarios) {
        assert.equal(s.decision, 'deny', `scenario not blocked: ${s.scenario}`);
      }
      const rules = out.scenarios.map((s) => s.rule ?? '');
      assert.equal(new Set(rules).size, 4,
        `four scenarios must trip four distinct rules, got: ${rules.join(' | ')}`);
    } finally { sb.cleanup(); }
  });

  test('the human output prints four distinct cards, one per scenario', () => {
    const sb = sandbox();
    try {
      const json = JSON.parse(demo(['--json'], sb.root)) as { scenarios: { rule?: string }[] };
      const expected = json.scenarios.map((s) => s.rule ?? '');

      const human = demo([], sb.root);
      // Each card carries a `rule` line; that is the field which differed between the scenarios
      // and was duplicated when the wrong row was fetched.
      const printed = [...human.matchAll(/^\s*│ rule\s+(.+?)\s*│$/gm)].map((m) => m[1]!.trim());

      assert.equal(printed.length, 4,
        `expected four incident cards, saw ${printed.length}`);
      assert.equal(new Set(printed).size, 4,
        `the demo printed the same card more than once: ${printed.join(' | ')}`);
      for (const rule of expected) {
        assert.ok(printed.some((p) => rule.startsWith(p) || p.startsWith(rule.split(' ')[0]!)),
          `no card printed for rule ${rule}; cards showed: ${printed.join(' | ')}`);
      }
    } finally { sb.cleanup(); }
  });
});
