import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { triage } from '../bots/triage/src/triage.js';
import { Corpus } from '../bots/triage/src/corpus.js';

/**
 * ISSUE #14, VERBATIM, AS A COMMITTED REGRESSION CASE.
 *
 * <https://github.com/djayamah/usewarden/issues/14> — opened 2026-08-21, four questions in one
 * sentence, and the bot answered it in public with:
 *
 *   "I could not find an answer to this in the published documents, so rather than guess I have
 *    left it for a human to answer properly."
 *
 * Every one of the four is answered in the repository's own documents. The decline was wrong on
 * all four counts, and it was wrong in public, on the founder's own repository, under a disclosure
 * line that told the reader the bot had read the documents.
 *
 * WHY THIS IS A TEST AND NOT A FIXED BUG WITH A NOTE IN DECISIONS.md.
 *
 * Four separate defects had to line up to produce that comment, and each was fixed in its own
 * commit: the production bot ran with NO CORPUS at all (D-164); the answer was scored as one
 * query so a four-part question diluted below the floor; the slot cap was a hard three so the
 * fourth question could not be answered even in principle; and `docs/METRICS.md` contained none of
 * the words a person uses to ask about monitoring. Any one of them reappearing reproduces the same
 * public failure, and three of the four were invisible to the eval sets that existed at the time —
 * all of which reported 20/20 while this was happening.
 *
 * So the issue text itself is the test. The eval sets score aggregate quality; this pins ONE real
 * comment that went out wrong, and it is written to fail on the specific shape of that failure
 * rather than on a score dropping.
 *
 * NOTE ON WHICH TREE THIS PROVES ANYTHING ABOUT. The corpus is the CHECKOUT, so this test states
 * something about the tree it runs in. That is deliberate and it is the D-152/D-171 lesson: the
 * README test count and the `firewall` wording were both fixed in the private repository while the
 * public one — the one the production bot actually reads — kept shipping the defect. This file
 * therefore has to travel to the public repository to mean anything, and CI runs it there.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The issue exactly as it was written. Do not tidy this — the phrasing is the test. */
const ISSUE_14 = {
  number: 14,
  title: 'Is this free or paid?',
  body: 'Is this free or paid? Also how do I install and use and monitor the impact of this?',
  user: 'djayamah',
};

/**
 * The four questions, and a term that only a passage genuinely answering it would contain.
 *
 * Deliberately NOT matched against a specific file or heading. Pinning the expected source would
 * make this test fail on any documentation reorganisation, which is a different thing from the
 * defect, and it would encourage the retriever to be tuned until this test passes rather than
 * until the answer is right.
 */
const FOUR_QUESTIONS: { asked: string; anyOf: RegExp[] }[] = [
  { asked: 'free or paid', anyOf: [/free and open source/i, /no paid tier/i, /costs nothing/i] },
  // Deliberately broad, and it was broadened for a reason worth recording. The first version
  // listed only the commands in the Quickstart CODE BLOCK, which is what the private tree happens
  // to quote — so it failed on the PUBLIC tree, where a differently-sized corpus ranks the FAQ
  // entry above the code block. Both are correct answers to "how do I install". A matcher that
  // passes only for the passage one tree happens to pick is testing the ranking, not the answer.
  { asked: 'how do I install', anyOf: [
    /npm install/i, /git clone/i, /clone it and build it/i, /cli\.js init/i, /npx usewarden/i,
    /How do I install it\?/i,
  ] },
  { asked: 'how do I use', anyOf: [/cli\.js (demo|status)/i, /usewarden (demo|status|init)/i] },
  { asked: 'monitor the impact', anyOf: [/usewarden incidents/i, /usewarden metrics/i, /incident wall/i] },
];

describe('issue #14: four questions in one sentence, and the bot declined all four', () => {
  const corpus = new Corpus(REPO);
  const result = triage(ISSUE_14, corpus);

  test('the corpus really loaded — a decline from an empty corpus is D-164, not an answer', () => {
    // The original failure's root cause. Without this assertion every check below could pass
    // vacuously on a bot that read nothing, which is precisely what happened in production.
    assert.ok(corpus.size > 0, 'the corpus must not be empty');
  });

  test('it is classified as a QUESTION, not a defect report', () => {
    // The comment that went out led with the question path correctly; an earlier version of this
    // same failure led with "Thanks for the report" and a demand for `usewarden status --json`
    // from someone who had installed nothing.
    assert.equal(result.intent, 'question', `intent was ${result.intent}: ${result.intentWhy}`);
  });

  test('IT ANSWERS — the exact regression: this must never decline again', () => {
    assert.ok(result.answer, 'a question must always carry an answer object, even a declining one');
    assert.equal(result.answer?.answered, true,
      'issue #14 declined in public; every one of its four questions is in the documents');
    assert.ok(!result.comment.includes('I could not find an answer to this'),
      'the verbatim decline sentence that was posted to #14 must not reappear');
  });

  test('all FOUR questions are answered, not merely three', () => {
    // The slot cap was a hard three. With four questions asked, one lost no matter how good
    // retrieval was — and the reader was told the documentation does not cover something it does.
    const missed = FOUR_QUESTIONS.filter((q) => !q.anyOf.some((re) => re.test(result.comment)));
    assert.deepEqual(missed.map((m) => m.asked), [],
      `unanswered: ${missed.map((m) => m.asked).join(', ')}\n\n--- comment ---\n${result.comment}`);
  });

  test('it does not quote the maintainer\'s own log of this failure back at the reader', () => {
    // D-167, and then again in a subtler form: `docs/METRICS.md` gained a section for exactly this
    // question, and the section OPENED with an italic aside explaining that the bot had failed
    // here. The excerpt logic biases toward a section's opening, so the bot quoted the aside — a
    // note about its own defect — as the answer. The fix moved the aside below the answer.
    assert.ok(!/This section exists because it was missing/i.test(result.comment),
      'the answer must be the answer, not the maintainer\'s note about why it was written');
    assert.ok(!/\bDECISIONS\.md\b/.test(result.comment),
      'the maintainer decision log is not an answer to a beginner\'s question');
  });

  test('it never echoes the issue text back as though it were documentation', () => {
    assert.ok(!result.comment.includes(ISSUE_14.body),
      'the bot must not quote the asker to the asker');
  });

  test('it is NOT labelled as a documentation gap, because there is no gap any more', () => {
    // The split that this issue motivated: `unmatched` used to mean three unrelated things.
    // An answered question is neither unmatched nor a docs gap.
    assert.ok(!result.labels.includes('unmatched'), `labels were ${result.labels.join(',')}`);
    assert.ok(!result.labels.includes('docs-gap'), `labels were ${result.labels.join(',')}`);
    assert.equal(result.route, 'likely-known');
  });

  test('the disclosure matches what it actually did', () => {
    // The original comment claimed "everything substantive above is a direct quotation" while
    // having quoted nothing. The disclosure is conditional now, and this pins the correct branch.
    assert.ok(result.comment.includes('Everything substantive above is a direct quotation'),
      'an answered question must carry the quoted-from-source disclosure');
    assert.ok(result.comment.includes('Automated triage'), 'it must identify itself as a bot');
  });
});

describe('issue #14: the documentation gap it found is genuinely closed', () => {
  test('the words a person actually asks in appear in docs/METRICS.md', () => {
    // The real finding underneath #14: `monitor`, `monitoring`, `impact`, `track` and `caught`
    // appeared ZERO times in a document about metrics. The bot was right that nothing matched;
    // the defect was in the documentation, and the fix belonged there rather than in the retriever.
    const metrics = new Corpus(REPO, ['docs/METRICS.md'], false);
    assert.ok(metrics.size > 0, 'docs/METRICS.md must be in the corpus');
    const text = metrics.chunks.map((c) => c.text).join('\n').toLowerCase();
    for (const word of ['monitor', 'impact', 'track', 'caught']) {
      assert.ok(text.includes(word), `docs/METRICS.md still never says "${word}"`);
    }
  });
});
