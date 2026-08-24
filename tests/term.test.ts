import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { box, wrapLine, stripAnsi, dim, bad } from '../src/term.js';
import { defaultCommandDeny } from '../src/policy/schema.js';

/**
 * THE INCIDENT CARD IS THE PRODUCT'S SCREENSHOT (SPEC-BUILD 3.6), AND IT HAD NO TESTS.
 *
 * That is how a card with a broken right-hand border reached a live capture: `wrapLine` compared
 * the remaining text against `width` but emitted continuation lines as `indent + text`, so the
 * FINAL fragment of a wrapped two-column line could be up to one indent wider than the box. Only
 * a final fragment between `width - indentWidth` and `width` long triggers it, which is narrow
 * enough that reading a few cards will not find it and wide enough that real messages hit it.
 *
 * So this file asserts the INVARIANT rather than the case: for every message the shipped policy
 * can produce, at every width, no rendered line is wider than the frame that holds it.
 */

/** Every reason string the default policy can put on a card, plus the ones built in the engine. */
const REAL_MESSAGES: string[] = [
  ...defaultCommandDeny().map((r) => `Usewarden: ${r.reason}`),
  'Usewarden: src/todos.js has uncommitted changes that git cannot restore. Replacing the whole '
  + 'file would discard them. Stage or commit them first (`git add src/todos.js`), or make a '
  + 'targeted edit that keeps what is already there.',
  'Usewarden: RELEASE-NOTES.md exists and git has never seen it, so the copy on disk is the only '
  + 'one. Replacing it wholesale would destroy work nobody can get back. Put the current contents '
  + 'somewhere recoverable first — `git add RELEASE-NOTES.md` is enough — or write to a different file.',
  'Usewarden: reading a .env file puts live credentials into the model context. Blocked. Ask the '
  + 'human for the specific value you need.',
  'Usewarden: /Users/someone/a/very/long/absolute/path/with/no/spaces/at/all/whatsoever/file.ts '
  + 'is outside this session’s allowed scope.',
];

const LABELS = ['when', 'agent', 'attempt', 'why', 'rule'];

describe('wrapLine never emits a line wider than the width it was given', () => {
  test('every real policy message, at every width from 20 to 120', () => {
    const failures: string[] = [];
    for (const msg of REAL_MESSAGES) {
      for (const label of LABELS) {
        const line = `${label}${' '.repeat(Math.max(2, 9 - label.length))}${msg}`;
        for (let w = 20; w <= 120; w++) {
          for (const out of wrapLine(line, w)) {
            const len = stripAnsi(out).length;
            if (len > w) failures.push(`width ${w}, label "${label}": got ${len} — ${JSON.stringify(out)}`);
          }
        }
      }
    }
    assert.deepEqual(failures.slice(0, 5), [],
      `${failures.length} lines overflowed their box:\n  - ${failures.slice(0, 5).join('\n  - ')}`);
  });

  test('an unbreakable token still hard-splits rather than blowing the frame apart', () => {
    const line = `attempt  ${'x'.repeat(300)}`;
    for (const out of wrapLine(line, 40)) assert.ok(stripAnsi(out).length <= 40);
  });

  test('colour does not count toward the visible width', () => {
    const line = `why      ${dim('a '.repeat(60))}`;
    for (const out of wrapLine(line, 40)) assert.ok(stripAnsi(out).length <= 40);
  });

  test('short lines are returned untouched', () => {
    assert.deepEqual(wrapLine('why      short', 40), ['why      short']);
  });
});

describe('box: every border lines up', () => {
  test('a real incident card is rectangular at every width', () => {
    for (const msg of REAL_MESSAGES) {
      for (let w = 30; w <= 120; w++) {
        const rendered = box('Blocked overwrite of work git cannot restore', [
          'when     2026-08-24 10:45:42Z',
          'agent    claude  live session',
          'attempt  Write ~/dev/warden/fixtures/sandbox-project/src/todos.js',
          `why      ${msg}`,
          'rule     scope.protect_uncommitted (modified)  (layer 1)',
        ], w);
        const lines = rendered.split('\n').map((l) => stripAnsi(l).length);
        const uniq = [...new Set(lines)];
        assert.equal(uniq.length, 1,
          `at maxWidth ${w} the card is not rectangular: line widths ${uniq.join(', ')}\n${rendered}`);
      }
    }
  });

  test('a card whose title is longer than the frame still closes', () => {
    const rendered = box(`${'T'.repeat(200)}`, ['why      x'], 40);
    const uniq = [...new Set(rendered.split('\n').map((l) => stripAnsi(l).length))];
    assert.equal(uniq.length, 1, `widths ${uniq.join(', ')}`);
  });

  test('a coloured badge inside a card does not shift the border', () => {
    const rendered = box('t', [`why      ${bad('BLOCKED')} and then some ordinary prose after it`], 40);
    const uniq = [...new Set(rendered.split('\n').map((l) => stripAnsi(l).length))];
    assert.equal(uniq.length, 1, `widths ${uniq.join(', ')}`);
  });
});
