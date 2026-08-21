import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Corpus } from '../bots/triage/src/corpus.js';
import { triage } from '../bots/triage/src/triage.js';
import { classifyIntent } from '../bots/triage/src/intent.js';
import { runBeginnerEval, BEGINNER_SET, QUESTION_MUST_NOT } from '../bots/triage/src/beginner-eval.js';
import { botProseOnly } from '../bots/triage/src/answer.js';

/**
 * THE BEGINNER EVAL, AS A GATE.
 *
 * The original eval set sat at 20/20 through two separate public failures, because every question
 * in it is one clean sentence in the project's own vocabulary. Scored against phrasing real
 * beginners use, the same bot managed 4/12. A number that only ever goes up is not a measurement,
 * so this set runs in the suite and a regression fails the build.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const corpus = new Corpus(REPO);
const intentOf = (i: Parameters<typeof classifyIntent>[0]): ReturnType<typeof classifyIntent>['intent'] =>
  classifyIntent(i).intent;

describe('bot: intent is decided before anything else', () => {
  test('every beginner-phrased case is classified correctly', () => {
    const wrong = BEGINNER_SET
      .map((c) => ({ c, got: classifyIntent({ number: 1, title: c.title, body: c.body, user: 'x' }) }))
      .filter(({ c, got }) => got.intent !== c.expectIntent);
    assert.deepEqual(wrong.map(({ c, got }) => `${c.id}: ${got.intent} != ${c.expectIntent}`), []);
  });

  test('an unrecognised issue is a QUESTION, never a defect report', () => {
    // The default decides what a beginner gets when nothing matches, and the two mistakes cost
    // wildly different amounts: a documentation quote on a bug report wastes one comment, while
    // the triage template on a beginner's question is the failure that happened twice in public.
    const r = classifyIntent({ number: 1, user: 'x', title: 'hello', body: 'a message with no recognisable signal in it whatsoever' });
    assert.equal(r.intent, 'question');
    assert.match(r.why, /fails safe/);
  });

  test('a real bypass report still reaches the security route', () => {
    // Narrowing the security route so beginners are not alarmed must not stop a genuine report.
    const r = triage({
      number: 1, user: 'x', title: 'i think i found a way round the env blocking',
      body: 'if you use a different command to read it the .env file still gets through',
    }, corpus);
    assert.equal(r.intent, 'security');
    assert.equal(r.route, 'security');
    assert.match(r.comment, /advisories\/new/);
  });
});

describe('bot: what a question must never receive', () => {
  for (const c of BEGINNER_SET.filter((x) => x.expectIntent === 'question')) {
    test(`${c.id}: no diagnostics, no credential warning, no "thanks for the report"`, () => {
      const r = triage({ number: 1, title: c.title, body: c.body, user: 'x' }, corpus);
      const prose = botProseOnly(r.comment);
      for (const f of QUESTION_MUST_NOT) {
        assert.equal(f.re.test(prose), false, f.why);
      }
    });
  }

  test('a feature request gets no invented roadmap and no quotation', () => {
    const r = triage({ number: 1, user: 'x', title: 'any chance of windows support', body: 'would love to use this but im on windows' }, corpus);
    assert.equal(r.intent, 'feature');
    assert.equal(r.answer, undefined, 'quoted something at a question about the future');
    assert.ok(r.labels.includes('enhancement'));
    assert.match(r.comment, /no roadmap document here for me to quote/);
  });
});

describe('bot: the beginner eval score', () => {
  test('every case passes, and the failures are named when they do not', () => {
    const results = runBeginnerEval(corpus, intentOf, BEGINNER_SET);
    const failed = results.filter((r) => !r.passed);
    assert.deepEqual(failed.map((r) => `${r.id}: ${r.detail}`), [],
      `beginner eval ${results.length - failed.length}/${results.length}`);
  });

  test('the set itself is not degenerate - it contains bugs and features, not only questions', () => {
    // A set made only of questions would score 12/12 for a bot that answers everything and
    // triages nothing, which is the opposite defect and just as bad.
    const kinds = new Set(BEGINNER_SET.map((c) => c.expectIntent));
    for (const k of ['question', 'bug', 'feature', 'security']) {
      assert.ok(kinds.has(k as never), `the beginner set has no ${k} case`);
    }
    assert.ok(BEGINNER_SET.some((c) => c.body.length > 400), 'no long rambling body in the set');
    assert.ok(BEGINNER_SET.some((c) => !`${c.title}${c.body}`.includes('?')),
      'every case has a question mark - that is the shape that hid the defect twice');
  });
});
