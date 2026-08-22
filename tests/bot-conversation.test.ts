import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldReply, isOwnComment, explainRefusal, BOT_DISCLOSURE_MARKER,
  type ConversationContext, type ThreadComment, type ReplyRefusal,
} from '../bots/triage/src/conversation.js';

/**
 * LOOP SABOTAGE, and every case asserts the sabotage LANDED before asserting the catch.
 *
 * "The sabotage landed" here means: the thread really is in the dangerous shape — the bot really
 * did already speak, the author really is flagged as a bot, the trailing comments really are
 * consecutive. A test that passes because the fixture was built wrong is worse than no test
 * (CLAUDE.md §4.2), and for a loop guard it is much worse: the failure it hides is unbounded.
 */

const bot = (body = `hi\n_🤖 **${BOT_DISCLOSURE_MARKER} — I am a bot.**_`): ThreadComment =>
  ({ author: 'github-actions[bot]', isBot: true, body });
const human = (author: string, body = 'a question'): ThreadComment =>
  ({ author, isBot: false, body });

const ctx = (over: Partial<ConversationContext> = {}): ConversationContext => ({
  surface: 'issue_comment',
  triggeredBy: 'stranger',
  triggeredByIsBot: false,
  comments: [],
  maintainers: ['djayamah'],
  closed: false,
  ...over,
});

const refusal = (c: ConversationContext): ReplyRefusal | 'REPLIED' => {
  const d = shouldReply(c);
  return d.reply ? 'REPLIED' : d.reason;
};

describe('conversation guard: the baseline it must not break', () => {
  test('a stranger asking a question on a quiet thread gets an answer', () => {
    assert.equal(refusal(ctx()), 'REPLIED');
  });

  test('a stranger asking after somebody ELSE was answered still gets an answer', () => {
    // The opposite failure to rule 2, and just as bad: one earlier bot comment addressed to
    // someone else must not permanently silence the bot for every later participant.
    const c = ctx({
      triggeredBy: 'newcomer',
      comments: [human('other'), bot()],
    });
    assert.ok(c.comments.some(isOwnComment), 'setup: the bot must already have spoken');
    assert.ok(!c.comments.some((x) => x.author === 'newcomer'),
      'setup: the newcomer must not already be in the thread');
    assert.equal(refusal(c), 'REPLIED');
  });

  test('every supported surface can be answered on', () => {
    for (const surface of ['issue', 'issue_comment', 'discussion',
      'discussion_comment', 'pr_comment'] as const) {
      assert.equal(refusal(ctx({ surface })), 'REPLIED', `${surface} was refused`);
    }
  });
});

describe('LOOP SABOTAGE 1: the bot must never reply to itself', () => {
  test('the sabotage lands: a comment carrying the disclosure IS recognised as its own', () => {
    const own = bot();
    assert.equal(own.isBot, true, 'setup: must be flagged as a bot account');
    assert.ok(own.body.includes(BOT_DISCLOSURE_MARKER), 'setup: must carry the disclosure marker');
    assert.equal(isOwnComment(own), true);
  });

  test('an event triggered by the bot itself is REFUSED', () => {
    assert.equal(
      refusal(ctx({ triggeredBy: 'github-actions[bot]', triggeredByIsBot: true })),
      'author_is_bot');
  });

  test('a DIFFERENT bot is refused too — two bots answering each other is still a loop', () => {
    assert.equal(
      refusal(ctx({ triggeredBy: 'dependabot[bot]', triggeredByIsBot: true })),
      'author_is_bot');
  });

  test('the refusal does not depend on the marker, only on the bot flag', () => {
    // A bot comment with no marker is some other automation. It must still not be answered.
    const c = ctx({ triggeredBy: 'renovate[bot]', triggeredByIsBot: true });
    assert.equal(isOwnComment({ author: 'renovate[bot]', isBot: true, body: 'no marker here' }),
      false, 'setup: this must NOT look like our own comment');
    assert.equal(refusal(c), 'author_is_bot');
  });
});

describe('LOOP SABOTAGE 2: never twice to the same person in a thread', () => {
  test('the sabotage lands: the person really is in the thread and the bot really answered after', () => {
    const comments = [human('stranger'), bot()];
    const first = comments.findIndex((x) => x.author === 'stranger');
    assert.ok(first >= 0, 'setup: the person must be in the thread');
    assert.ok(comments.slice(first + 1).some(isOwnComment),
      'setup: the bot must have spoken AFTER them');
    assert.equal(refusal(ctx({ comments })), 'already_answered_this_person');
  });

  test('asking three more times does not wear it down', () => {
    const comments = [human('stranger'), bot(), human('stranger', 'still confused'),
      human('stranger', 'anyone?')];
    assert.equal(refusal(ctx({ comments })), 'already_answered_this_person');
  });

  test('the check is case-insensitive on the login', () => {
    assert.equal(refusal(ctx({ triggeredBy: 'STRANGER', comments: [human('stranger'), bot()] })),
      'already_answered_this_person');
  });

  test('a bot comment BEFORE the person ever spoke does not count against them', () => {
    const comments = [bot(), human('stranger')];
    assert.equal(comments.findIndex((x) => x.author === 'stranger'), 1, 'setup: person speaks second');
    assert.equal(refusal(ctx({ comments })), 'REPLIED');
  });
});

describe('LOOP SABOTAGE 3: never reply to a maintainer', () => {
  test('the founder is refused', () => {
    assert.equal(refusal(ctx({ triggeredBy: 'djayamah' })), 'author_is_maintainer');
  });
  test('case does not matter', () => {
    assert.equal(refusal(ctx({ triggeredBy: 'DJayamah' })), 'author_is_maintainer');
  });
});

describe('LOOP SABOTAGE 4: never the third consecutive bot comment', () => {
  test('the sabotage lands: the last two really are consecutive bot comments', () => {
    const comments = [human('stranger'), bot(), bot()];
    const tail = comments.slice(-2);
    assert.ok(tail.every((c) => c.isBot), 'setup: the last two must both be bot comments');
    assert.equal(refusal(ctx({ triggeredBy: 'newcomer', comments })),
      'would_be_third_consecutive_bot_comment');
  });

  test('two bot comments separated by a human do NOT trip it', () => {
    const comments = [bot(), human('someone'), bot()];
    assert.equal(comments[comments.length - 2]?.isBot, false, 'setup: a human must break the run');
    assert.equal(refusal(ctx({ triggeredBy: 'newcomer', comments })), 'REPLIED');
  });

  test('it counts ANY bot, not just this one — two different bots still make a monologue', () => {
    const comments: ThreadComment[] = [
      human('stranger'),
      bot(),
      { author: 'other-bot[bot]', isBot: true, body: 'unrelated automation' },
    ];
    assert.equal(comments.filter((c) => isOwnComment(c)).length, 1,
      'setup: only ONE of the trailing comments is ours');
    assert.equal(refusal(ctx({ triggeredBy: 'newcomer', comments })),
      'would_be_third_consecutive_bot_comment');
  });

  test('a long bot run is still refused, not just exactly two', () => {
    assert.equal(refusal(ctx({ triggeredBy: 'newcomer', comments: [bot(), bot(), bot(), bot()] })),
      'would_be_third_consecutive_bot_comment');
  });
});

describe('conversation guard: it fails CLOSED', () => {
  test('an unnamed author is refused rather than assumed safe', () => {
    // A deleted account presents as an empty login. It cannot be checked against the maintainer
    // list or the already-answered rule, so it cannot be cleared by them either.
    assert.equal(refusal(ctx({ triggeredBy: '' })), 'unknown_author');
    assert.equal(refusal(ctx({ triggeredBy: '   ' })), 'unknown_author');
  });

  test('an unknown surface is refused', () => {
    assert.equal(refusal(ctx({ surface: 'wiki_edit' as never })), 'unsupported_surface');
  });

  test('a closed thread is refused', () => {
    assert.equal(refusal(ctx({ closed: true })), 'thread_closed');
  });

  test('the strongest reason wins when several apply', () => {
    // A closed thread whose author is also a bot reports the thread state, not the author: the
    // conversation is over regardless of who spoke last.
    assert.equal(refusal(ctx({ closed: true, triggeredBy: 'x[bot]', triggeredByIsBot: true })),
      'thread_closed');
  });

  test('every refusal reason has a human-readable explanation', () => {
    const all: ReplyRefusal[] = ['thread_closed', 'author_is_bot', 'author_is_maintainer',
      'already_answered_this_person', 'would_be_third_consecutive_bot_comment',
      'unknown_author', 'unsupported_surface'];
    for (const r of all) {
      assert.ok(explainRefusal(r).length > 10, `${r} has no usable explanation`);
    }
  });
});

describe('the runaway case, end to end', () => {
  test('a bot reply cannot trigger another: feeding its own output back stops immediately', () => {
    // The actual infinite loop, simulated. The bot answers, that comment becomes a new event on
    // the same thread, and the guard must refuse it on the FIRST bounce - not the second.
    let thread: ThreadComment[] = [human('stranger')];
    let replies = 0;

    for (let bounce = 0; bounce < 10; bounce++) {
      const triggering = thread[thread.length - 1];
      if (!triggering) break;
      const d = shouldReply(ctx({
        triggeredBy: triggering.author,
        triggeredByIsBot: triggering.isBot,
        comments: thread.slice(0, -1),
      }));
      if (!d.reply) break;
      thread = [...thread, bot()];
      replies++;
    }

    assert.equal(replies, 1, `the bot replied ${replies} times to one question`);
    assert.equal(thread.filter((c) => c.isBot).length, 1, 'more than one bot comment on the thread');
  });
});
