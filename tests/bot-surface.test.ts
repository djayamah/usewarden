import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { run, type GitHubApi } from '../bots/triage/src/run.js';
import {
  parseSurfaces, surfaceFromEvent, KNOWN_SURFACES, DEFAULT_SURFACES, type Surface,
} from '../bots/triage/src/surface.js';
import { discussionApi } from '../bots/triage/src/discussions.js';
import { BOT_DISCLOSURE_MARKER } from '../bots/triage/src/conversation.js';

/**
 * THE WIRING, NOT THE RULES.
 *
 * `tests/bot-conversation.test.ts` proves `shouldReply()` — the four loop rules, in isolation, as
 * a pure function. This file proves the thing that was missing until now: that the guard is
 * ACTUALLY CALLED on the path that posts, that the surface switch gates it, and that widening the
 * triggers did not quietly change what happens on `issues: opened`.
 *
 * That distinction is the whole reason this file exists. CLAUDE.md §4.3 — "fixtures prove a check
 * works, only production proves it fires" — and the closest thing to production available in a
 * unit test is running the real `run()` against a fake API and asserting on what it POSTED. A
 * guard that is proven correct and never invoked is the drift-guardian defect again: a control
 * that passes its own tests while not running.
 */

// '..', '..' because this resolves from `dist/tests/` at runtime, not from `tests/`. One level
// short lands on `dist/`, where the corpus loads nothing and every test below fails as
// `empty_corpus` — which is exactly what happened the first time this file ran.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A fake API that records what was posted. Same shape as the one in bot.test.ts. */
function api(over: Partial<GitHubApi> = {}): GitHubApi & { posted: string[]; labelled: string[] } {
  const posted: string[] = [];
  const labelled: string[] = [];
  return {
    posted,
    labelled,
    getIssue: async () => ({
      number: 1, title: 'does it need an api key', body: 'do i have to pay for this',
      user: 'stranger', labels: [], state: 'open',
    }),
    listIssueComments: async () => [],
    createComment: async (_n, b) => { posted.push(b); },
    addLabels: async (_n, l) => { labelled.push(...l); },
    countRecentBotComments: async () => 0,
    ...over,
  } as GitHubApi & { posted: string[]; labelled: string[] };
}

const ownComment = (author = 'usewarden[bot]'): { user: string; isBot: boolean; body: string } =>
  ({ user: author, isBot: true, body: `answer\n\n_🤖 ${BOT_DISCLOSURE_MARKER} — I am a bot._` });

describe('surface switch: parsing', () => {
  test('unset means issues only — exactly what the bot did before the wider surface', () => {
    for (const v of [undefined, '', '   ', ',,', ' , ']) {
      assert.deepEqual(parseSurfaces(v).surfaces, [...DEFAULT_SURFACES],
        `${JSON.stringify(v)} must fall back to the default`);
    }
    assert.deepEqual([...DEFAULT_SURFACES], ['issue'], 'the default is issues and nothing else');
  });

  test('named surfaces are honoured, in comma or space form, any case', () => {
    assert.deepEqual(parseSurfaces('issue,issue_comment').surfaces, ['issue', 'issue_comment']);
    assert.deepEqual(parseSurfaces('ISSUE Discussion').surfaces, ['issue', 'discussion']);
    assert.deepEqual(parseSurfaces('issue, issue ,issue').surfaces, ['issue'], 'deduplicated');
  });

  test('there is deliberately NO wildcard — "all" enables nothing', () => {
    const { surfaces, unknown } = parseSurfaces('all');
    assert.deepEqual(surfaces, [...DEFAULT_SURFACES], '"all" must not widen anything');
    assert.deepEqual(unknown, ['all'], 'and it must be reported rather than swallowed');
  });

  test('a typo is reported AND dropped, and does not take the good names with it', () => {
    const { surfaces, unknown } = parseSurfaces('issue,discusion,discussion');
    assert.deepEqual(surfaces, ['issue', 'discussion']);
    assert.deepEqual(unknown, ['discusion']);
  });

  test('a value naming ONLY nonsense falls back rather than disabling the bot', () => {
    // Being off is what TRIAGE_BOT_ENABLED is for. A typo in the widening variable must not be a
    // silent second kill switch — that failure looks like a broken bot, not a misconfigured one.
    const { surfaces, unknown } = parseSurfaces('issues,discussions');   // both plural, both wrong
    assert.deepEqual(surfaces, [...DEFAULT_SURFACES]);
    assert.deepEqual(unknown, ['issues', 'discussions']);
  });

  test('every known surface is reachable by name', () => {
    for (const s of KNOWN_SURFACES) {
      assert.deepEqual(parseSurfaces(s).surfaces, [s], `${s} must parse to itself`);
    }
  });
});

describe('surface switch: mapping the GitHub event', () => {
  test('each event maps to the surface it actually is', () => {
    assert.equal(surfaceFromEvent('issues', false), 'issue');
    assert.equal(surfaceFromEvent('discussion', false), 'discussion');
    assert.equal(surfaceFromEvent('discussion_comment', false), 'discussion_comment');
  });

  test('issue_comment is TWO surfaces, told apart by the pull_request field', () => {
    // GitHub models a pull request as an issue, so both arrive as `issue_comment`. They are
    // different rooms socially and a maintainer may want the bot in one and not the other.
    assert.equal(surfaceFromEvent('issue_comment', false), 'issue_comment');
    assert.equal(surfaceFromEvent('issue_comment', true), 'pr_comment');
  });

  test('an event with no mapping returns null rather than a guess', () => {
    for (const e of ['push', 'pull_request', 'workflow_dispatch', 'schedule', '']) {
      assert.equal(surfaceFromEvent(e, false), null, `${e} must not map to a surface`);
    }
  });
});

describe('surface switch: it gates the path that posts', () => {
  test('THE SABOTAGE LANDS: with the surface enabled, this exact input really does post', async () => {
    // Assert the dangerous thing is present before asserting the defence catches it (CLAUDE.md
    // §4.2). Without this, every refusal below could be a setup that silently did nothing.
    const a = api();
    const out = await run({
      repoRoot: REPO, issueNumber: 1, api: a, enabledVar: 'true',
      enabledSurfaces: ['issue_comment'],
      event: { surface: 'issue_comment', triggeredBy: 'stranger', triggeredByIsBot: false },
    });
    assert.equal(out.acted, true, 'the baseline must post, or the refusals below prove nothing');
    assert.equal(a.posted.length, 1);
  });

  test('a surface not in the variable is refused, and nothing is posted', async () => {
    for (const s of ['issue_comment', 'discussion', 'discussion_comment', 'pr_comment'] as Surface[]) {
      const a = api();
      const out = await run({
        repoRoot: REPO, issueNumber: 1, api: a, enabledVar: 'true',
        enabledSurfaces: ['issue'],
        event: { surface: s, triggeredBy: 'stranger', triggeredByIsBot: false },
      });
      assert.deepEqual(out, { acted: false, reason: 'surface_not_enabled' }, `${s} must be refused`);
      assert.equal(a.posted.length, 0, `${s} must post nothing`);
    }
  });

  test('OMITTING the surface list means issues only — the pre-existing behaviour, unchanged', async () => {
    const a = api();
    const issueOnly = await run({ repoRoot: REPO, issueNumber: 1, api: a, enabledVar: 'true' });
    assert.equal(issueOnly.acted, true, 'issues: opened must still work with no configuration');

    const b = api();
    const wider = await run({
      repoRoot: REPO, issueNumber: 1, api: b, enabledVar: 'true',
      event: { surface: 'discussion', triggeredBy: 'stranger', triggeredByIsBot: false },
    });
    assert.deepEqual(wider, { acted: false, reason: 'surface_not_enabled' });
    assert.equal(b.posted.length, 0);
  });

  test('the surface check runs BEFORE the issue is ever fetched', async () => {
    // A gate that reads the thread first has already spent the API call and, worse, could act on
    // a partially-taken decision if a later step throws.
    const a = api({ getIssue: async () => { throw new Error('must not be called'); } });
    const out = await run({
      repoRoot: REPO, issueNumber: 1, api: a, enabledVar: 'true',
      enabledSurfaces: ['issue'],
      event: { surface: 'discussion', triggeredBy: 'x', triggeredByIsBot: false },
    });
    assert.deepEqual(out, { acted: false, reason: 'surface_not_enabled' });
  });

  test('the kill switch still outranks the surface switch', async () => {
    const a = api();
    const out = await run({
      repoRoot: REPO, issueNumber: 1, api: a, enabledVar: 'false',
      enabledSurfaces: [...KNOWN_SURFACES],
      event: { surface: 'issue_comment', triggeredBy: 'stranger', triggeredByIsBot: false },
    });
    assert.deepEqual(out, { acted: false, reason: 'kill_switch_variable' });
    assert.equal(a.posted.length, 0);
  });
});

describe('the conversation guard is actually invoked by run(), not merely proven in isolation', () => {
  const wide = { enabledSurfaces: [...KNOWN_SURFACES] };

  test('it refuses a maintainer, and posts nothing', async () => {
    const a = api();
    const out = await run({
      repoRoot: REPO, issueNumber: 1, api: a, enabledVar: 'true', ...wide,
      maintainers: ['djayamah'],
      event: { surface: 'issue_comment', triggeredBy: 'DJayamah', triggeredByIsBot: false },
    });
    assert.deepEqual(out, { acted: false, reason: 'conversation_guard', refusal: 'author_is_maintainer' });
    assert.equal(a.posted.length, 0);
  });

  test('it refuses a second answer to the same person on a thread', async () => {
    const a = api({
      listIssueComments: async () => [
        { user: 'stranger', isBot: false, body: 'first question' },
        ownComment(),
      ],
    });
    const out = await run({
      repoRoot: REPO, issueNumber: 1, api: a, enabledVar: 'true', ...wide,
      event: { surface: 'issue_comment', triggeredBy: 'stranger', triggeredByIsBot: false },
    });
    assert.deepEqual(out,
      { acted: false, reason: 'conversation_guard', refusal: 'already_answered_this_person' });
    assert.equal(a.posted.length, 0);
  });

  test('it refuses to be the third consecutive bot comment', async () => {
    const a = api({
      listIssueComments: async () => [ownComment('one[bot]'), ownComment('two[bot]')],
    });
    const out = await run({
      repoRoot: REPO, issueNumber: 1, api: a, enabledVar: 'true', ...wide,
      event: { surface: 'issue_comment', triggeredBy: 'stranger', triggeredByIsBot: false },
    });
    assert.deepEqual(out, {
      acted: false, reason: 'conversation_guard',
      refusal: 'would_be_third_consecutive_bot_comment',
    });
    assert.equal(a.posted.length, 0);
  });

  test('an author the API did not name is refused rather than assumed safe', async () => {
    const a = api();
    const out = await run({
      repoRoot: REPO, issueNumber: 1, api: a, enabledVar: 'true', ...wide,
      event: { surface: 'issue_comment', triggeredBy: '', triggeredByIsBot: false },
    });
    assert.deepEqual(out, { acted: false, reason: 'conversation_guard', refusal: 'unknown_author' });
    assert.equal(a.posted.length, 0);
  });

  test('an empty triggeredBy must NOT fall back to the issue author', async () => {
    // This is the bug this test was written for. `??` and `||` differ here, and `||` would treat
    // "the API did not name them" as "use the issue author", judging a comment against the wrong
    // person's history. The issue author is a perfectly ordinary login, so `||` would have posted.
    const a = api({
      getIssue: async () => ({
        number: 1, title: 'x', body: 'do i have to pay', user: 'stranger', labels: [], state: 'open',
      }),
    });
    const out = await run({
      repoRoot: REPO, issueNumber: 1, api: a, enabledVar: 'true', ...wide,
      event: { surface: 'issue_comment', triggeredBy: '', triggeredByIsBot: false },
    });
    assert.equal(out.acted, false);
    assert.equal(a.posted.length, 0, 'falling back to the issue author here would have posted');
  });

  test('a bot-triggered event is refused on every surface', async () => {
    for (const s of KNOWN_SURFACES) {
      const a = api();
      const out = await run({
        repoRoot: REPO, issueNumber: 1, api: a, enabledVar: 'true', ...wide,
        event: { surface: s, triggeredBy: 'other[bot]', triggeredByIsBot: true },
      });
      assert.deepEqual(out, { acted: false, reason: 'bot_author' }, `${s} must refuse a bot`);
      assert.equal(a.posted.length, 0);
    }
  });
});

describe('one-comment-per-issue applies to `issues: opened` and NOT to a conversation', () => {
  const thread = [
    { user: 'first-asker', isBot: false, body: 'an earlier question' },
    ownComment(),
  ];

  test('on `issues: opened` an existing bot comment still halts it', async () => {
    const a = api({ listIssueComments: async () => thread });
    const out = await run({ repoRoot: REPO, issueNumber: 1, api: a, enabledVar: 'true' });
    assert.deepEqual(out, { acted: false, reason: 'already_commented' });
  });

  test('on a comment surface a DIFFERENT person still gets an answer', async () => {
    // The rule the founder set is "never twice to the same person", not "never twice on a thread".
    // Reusing the issue rule here would let whoever asks first silence the bot for everyone else.
    const a = api({ listIssueComments: async () => thread });
    const out = await run({
      repoRoot: REPO, issueNumber: 1, api: a, enabledVar: 'true',
      enabledSurfaces: ['issue_comment'],
      event: { surface: 'issue_comment', triggeredBy: 'second-asker', triggeredByIsBot: false },
    });
    assert.equal(out.acted, true, 'a second, different person must still be answerable');
    assert.equal(a.posted.length, 1);
  });

  test('...but the SAME person does not get a second answer', async () => {
    const a = api({ listIssueComments: async () => thread });
    const out = await run({
      repoRoot: REPO, issueNumber: 1, api: a, enabledVar: 'true',
      enabledSurfaces: ['issue_comment'],
      event: { surface: 'issue_comment', triggeredBy: 'first-asker', triggeredByIsBot: false },
    });
    assert.equal(out.acted, false);
    assert.equal(a.posted.length, 0);
  });
});

describe('the discussion adapter speaks GraphQL and presents the same shape', () => {
  const node = (over: Record<string, unknown> = {}): unknown => ({
    repository: {
      discussion: {
        id: 'D_kwDO', number: 7, title: 'is it free', body: 'do i have to pay for this',
        closed: false, isAnswered: false,
        author: { login: 'stranger', __typename: 'User' },
        comments: { nodes: [] },
        ...over,
      },
    },
  });

  test('it reads the discussion and posts through addDiscussionComment', async () => {
    const calls: string[] = [];
    const gql = async (q: string, v: Record<string, unknown>): Promise<unknown> => {
      calls.push(q.includes('addDiscussionComment') ? `post:${String(v['discussionId'])}` : 'read');
      return q.includes('addDiscussionComment') ? { addDiscussionComment: { comment: { id: 'c1' } } } : node();
    };
    const a = discussionApi(gql, 'djayamah/usewarden', async () => 0);
    const out = await run({
      repoRoot: REPO, issueNumber: 7, api: a, enabledVar: 'true',
      enabledSurfaces: ['discussion'],
      event: { surface: 'discussion', triggeredBy: 'stranger', triggeredByIsBot: false },
    });
    assert.equal(out.acted, true);
    assert.ok(calls.includes('post:D_kwDO'), `expected a post mutation, got ${calls.join(',')}`);
  });

  test('the thread is read ONCE, so the guard and the post see the same snapshot', async () => {
    let reads = 0;
    const gql = async (q: string): Promise<unknown> => {
      if (q.includes('addDiscussionComment')) return { addDiscussionComment: { comment: { id: 'c1' } } };
      reads++;
      return node();
    };
    const a = discussionApi(gql, 'djayamah/usewarden', async () => 0);
    await run({
      repoRoot: REPO, issueNumber: 7, api: a, enabledVar: 'true',
      enabledSurfaces: ['discussion'],
      event: { surface: 'discussion', triggeredBy: 'stranger', triggeredByIsBot: false },
    });
    assert.equal(reads, 1, 'two reads would be two snapshots, and a race in the guard');
  });

  test('an ANSWERED discussion counts as closed — somebody already concluded it', async () => {
    const gql = async (): Promise<unknown> => node({ isAnswered: true });
    const a = discussionApi(gql, 'djayamah/usewarden', async () => 0);
    const out = await run({
      repoRoot: REPO, issueNumber: 7, api: a, enabledVar: 'true',
      enabledSurfaces: ['discussion'],
      event: { surface: 'discussion', triggeredBy: 'stranger', triggeredByIsBot: false },
    });
    assert.deepEqual(out, { acted: false, reason: 'issue_closed' });
  });

  test('a GraphQL `errors` array is a failure, not a success with no data', async () => {
    // GraphQL answers 200 with an errors array. Treating that as success is how a bot reports
    // having posted something it did not post.
    const { makeGraphQLClient } = await import('../bots/triage/src/discussions.js');
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ data: null, errors: [{ message: 'Resource not accessible by integration' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;
    try {
      const client = makeGraphQLClient('t');
      await assert.rejects(() => client('query{}', {}), /Resource not accessible/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('a GraphQL bot author is recognised by __typename, not only by the [bot] suffix', async () => {
    const gql = async (): Promise<unknown> => node({
      author: { login: 'some-app', __typename: 'Bot' },
    });
    const a = discussionApi(gql, 'djayamah/usewarden', async () => 0);
    const out = await run({
      repoRoot: REPO, issueNumber: 7, api: a, enabledVar: 'true',
      enabledSurfaces: ['discussion'],
      // The event says not-a-bot; the thread says otherwise. The guard reads the trigger, so this
      // asserts the adapter's own mapping rather than the guard's.
      event: { surface: 'discussion', triggeredBy: 'some-app', triggeredByIsBot: true },
    });
    assert.deepEqual(out, { acted: false, reason: 'bot_author' });
  });
});
