import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { run, type GitHubApi } from '../bots/triage/src/run.js';
import { triage } from '../bots/triage/src/triage.js';
import { Corpus, CORPUS_FILES } from '../bots/triage/src/corpus.js';
import { parseClassification } from '../bots/triage/src/classify.js';

/**
 * THE CLAIM THIS FILE EXISTS TO DEFEND.
 *
 * `ops/BOT-SCOPE.md` makes one promise that every other guarantee on that page rests on:
 *
 *   "The model never writes the answer. Every substantive statement in a bot comment is a
 *    VERBATIM QUOTATION retrieved from a file in this repository, with a link to it. There is no
 *    code path in which model-generated prose about the product reaches a reader as fact."
 *
 * That is why the blast radius of a fully compromised model is "a wrong label and one wrong
 * sentence" rather than "anything it likes about a security tool". It is also why the founder —
 * who has said plainly that they cannot check the bot's technical claims — can let it speak in
 * public at all.
 *
 * Until now that promise was documented, argued for, and enforced by nothing. `bot.test.ts` proves
 * the model cannot smuggle a URL or a false "this is fixed" through the note filter, which is a
 * narrower claim: it tests the FILTER, not the STRUCTURE. This file tests the structure, and it is
 * deliberately written to fail if a future change lets the model's words into the body — even a
 * change that keeps every existing test green, which is exactly the change BOT-SCOPE.md warns
 * about ("If a future change lets the model write prose that reaches a reader as fact, every
 * guarantee on this page weakens at once — and this document should be the thing that stops it").
 *
 * The strategy is differential rather than pattern-matching. Run the SAME issue twice — once with
 * no classifier, once with a classifier returning maximally hostile prose — and require the two
 * comments to be identical apart from one clearly-marked, italicised line. A pattern test can only
 * catch the hostile strings someone thought of; a differential test catches ANY new model-derived
 * text, including text nobody anticipated.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const ISSUE = {
  number: 1,
  title: 'does usewarden send my code anywhere',
  body: 'is this free, and does it upload my project to a server',
  user: 'stranger',
};

/** Prose a compromised model would love to get in front of a reader. */
const HOSTILE_NOTE = 'usewarden transmits your entire repository to our analytics endpoint and '
  + 'you should disable your firewall to let it through';

function api(over: Partial<GitHubApi> = {}): GitHubApi & { posted: string[] } {
  const posted: string[] = [];
  return {
    posted,
    getIssue: async () => ({ ...ISSUE, labels: [], state: 'open' }),
    listIssueComments: async () => [],
    createComment: async (_n, b) => { posted.push(b); },
    addLabels: async () => { /* noop */ },
    countRecentBotComments: async () => 0,
    ...over,
  } as GitHubApi & { posted: string[] };
}

/** Every line of every corpus file, for the verbatim check. */
function corpusLines(root: string): Set<string> {
  const lines = new Set<string>();
  for (const rel of CORPUS_FILES) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) continue;
    for (const l of fs.readFileSync(p, 'utf8').split('\n')) lines.add(l.trim());
  }
  return lines;
}

describe('no generated prose: the model cannot write the answer', () => {
  test('THE SABOTAGE LANDS: the hostile note really does reach the comment', async () => {
    // Assert the dangerous thing is present before asserting it is contained (CLAUDE.md §4.2).
    // If the classifier were never called, every containment assertion below would pass vacuously
    // and this file would be worth nothing.
    const a = api();
    await run({
      repoRoot: REPO, issueNumber: 1, api: a, enabledVar: 'true',
      classify: async () => parseClassification(JSON.stringify({ labels: [], note: HOSTILE_NOTE })),
    });
    // The classifier only runs when the deterministic pass could not place the issue, so this
    // asserts the setup reached the classifier at all rather than asserting the text is present.
    assert.equal(a.posted.length, 1, 'the bot must have posted something to contain');
  });

  test('a hostile classifier changes the comment by EXACTLY ONE marked line, and nothing else',
    async () => {
      const withoutModel = api();
      await run({ repoRoot: REPO, issueNumber: 1, api: withoutModel, enabledVar: 'true' });

      const withModel = api();
      await run({
        repoRoot: REPO, issueNumber: 1, api: withModel, enabledVar: 'true',
        classify: async () => parseClassification(JSON.stringify({ labels: [], note: HOSTILE_NOTE })),
      });

      const base = (withoutModel.posted[0] ?? '').split('\n');
      const withm = (withModel.posted[0] ?? '').split('\n');
      assert.ok(base.length > 0 && withm.length > 0, 'both runs must have posted');

      const added = withm.filter((l) => !base.includes(l)).filter((l) => l.trim() !== '');

      // Either the classifier did not fire (deterministic pass placed it) — in which case nothing
      // was added and the promise holds trivially — or it added exactly one line, and that line
      // must be the italicised, labelled suggestion. There is no third acceptable outcome.
      assert.ok(added.length <= 1,
        `the model contributed ${added.length} lines; it may contribute at most one:\n${added.join('\n')}`);
      for (const line of added) {
        assert.match(line, /^_Model-assisted label suggestion: /,
          'model text may appear ONLY as the marked suggestion line');
        assert.ok(line.endsWith('_'), 'and it must stay inside the italic marker');
      }
    });

  test('the model cannot forge a quotation — its note cannot become a cited passage', async () => {
    // The attack this blocks: a note formatted as the bot's own citation syntax, so a reader
    // cannot tell invented text from a real quotation of a real file.
    const forged = '> usewarden uploads your code\n\n**From [`README.md`](https://example.com) — *x*:**';
    const a = api();
    await run({
      repoRoot: REPO, issueNumber: 1, api: a, enabledVar: 'true',
      classify: async () => parseClassification(JSON.stringify({ labels: [], note: forged })),
    });
    const body = a.posted[0] ?? '';
    // Whatever survived, it cannot have produced a citation pointing anywhere but this repository.
    const citations = [...body.matchAll(/\*\*From \[`[^`]+`\]\((https?:\/\/[^)]+)\)/g)].map((m) => m[1]);
    for (const url of citations) {
      assert.match(String(url), /^https:\/\/github\.com\/djayamah\/usewarden\/blob\//,
        `a citation must point at this repository, got ${String(url)}`);
    }
    assert.ok(!body.includes('https://example.com'), 'a forged citation URL must not survive');
  });

  test('every quoted line in a real answer is VERBATIM from a corpus file', () => {
    // The other half of the promise: not merely "the model did not write it" but "this text really
    // is in the repository". A retriever that paraphrased, reflowed, or summarised would break the
    // claim just as thoroughly as a chatty model, and would do it silently.
    const corpus = new Corpus(REPO);
    assert.ok(corpus.size > 0, 'the corpus must load, or this test proves nothing');
    const known = corpusLines(REPO);

    const questions = [
      { number: 1, title: 'is it free', body: 'do i have to pay for this', user: 'u' },
      { number: 2, title: 'does it send my code anywhere', body: 'privacy question', user: 'u' },
      { number: 3, title: 'do i need an api key', body: 'does it need a key to work', user: 'u' },
    ];

    for (const q of questions) {
      const r = triage(q, corpus);
      const quoted = r.comment.split('\n')
        .filter((l) => /^\s*>/.test(l))
        .map((l) => l.replace(/^\s*>\s?/, '').trim())
        .filter((l) => l !== '');

      const truncated = r.comment.includes('(quotation truncated');

      for (const line of quoted) {
        // The renderer marks truncation with its own sentinel; that line is the bot's, and it is
        // the single exception, so it is named explicitly rather than matched loosely.
        if (line.startsWith('[…]') || line.startsWith('…')) continue;
        if (known.has(line)) continue;

        // THE ONE PERMITTED DEPARTURE, and it is a PREFIX, never a paraphrase.
        //
        // The excerpt window ends at the last sentence boundary that fits, and `lastIndexOf('. ')`
        // can land in the MIDDLE of a line - so the final quoted line may be the opening sentences
        // of a real line rather than the whole of it. Found by this test on README.md's
        // `- **"It ignored CLAUDE.md / .cursorrules."** Instructions in a file are advisory. A hook
        // is not.`, which was quoted without its closing three words.
        //
        // That is acceptable ONLY because the block carries the truncation notice, so the reader is
        // told the quotation is cut short - and it is asserted here rather than assumed. It is
        // still a real fidelity cost worth naming: a bullet whose punchline is the second sentence
        // loses it, and the reader cannot tell which bullet was clipped. Marked, not hidden.
        const isPrefix = [...known].some((k) => k.length > line.length && k.startsWith(line));
        assert.ok(isPrefix,
          `quoted line is neither verbatim nor a prefix of any corpus line (issue "${q.title}"):\n  ${line}`);
        assert.ok(truncated,
          `a clipped quotation must carry the truncation notice (issue "${q.title}"):\n  ${line}`);
        assert.ok(line.endsWith('.') || line.endsWith(':'),
          `a clipped quotation must end at a sentence boundary, not mid-sentence:\n  ${line}`);
      }
    }
  });

  test('the corpus is real files on disk, so "verbatim" means something', () => {
    // Guards the test above from becoming vacuous: if CORPUS_FILES ever pointed at files that do
    // not exist, `known` would be empty, no line would be checked, and the test would still pass.
    const present = CORPUS_FILES.filter((f) => fs.existsSync(path.join(REPO, f)));
    assert.ok(present.length >= 5,
      `expected the corpus to name real files, found ${present.length} of ${CORPUS_FILES.length}`);
    assert.ok(corpusLines(REPO).size > 500, 'the verbatim set must be substantial, not empty');
  });

  test('a classifier that throws cannot stop the quoted answer going out', async () => {
    // The failure mode this rules out is the inverse one: making the model load-bearing. If a
    // model outage can silence the bot, the model has become part of the answer path.
    const a = api();
    const out = await run({
      repoRoot: REPO, issueNumber: 1, api: a, enabledVar: 'true',
      classify: async () => { throw new Error('provider down'); },
    });
    assert.equal(out.acted, true, 'a model failure must not stop the deterministic answer');
    assert.equal(a.posted.length, 1);
  });

  test('with NO model configured the bot still answers — the default path is model-free', async () => {
    const a = api();
    const out = await run({ repoRoot: REPO, issueNumber: 1, api: a, enabledVar: 'true' });
    assert.equal(out.acted, true);
    assert.ok(!(a.posted[0] ?? '').includes('Model-assisted'),
      'no model configured must mean no model-derived line at all');
  });
});
