/**
 * WHEN MAY THE BOT SPEAK IN A CONVERSATION?
 *
 * The bot used to fire on `issues: [opened]` and nothing else, so "may I speak" had exactly one
 * answer: yes, once, on a brand-new issue. Extending it to issue comments, discussion posts and
 * comments, and pull-request comments turns that into a real question, and the failure mode is
 * not "misses a question" — it is **talking over a conversation between two humans**. A support
 * bot that does that is worse than one that stays quiet, so every rule here fails CLOSED: an
 * input this cannot reason about is a refusal, never a reply.
 *
 * This is a PURE FUNCTION over a thread snapshot. No network, no clock, no filesystem — so every
 * loop case below is sabotage-testable without mocking GitHub, which is the only way the
 * self-reply and runaway cases get tested at all.
 *
 * The four rules the founder set, and what each is actually protecting against:
 *
 *   1. NEVER REPLY TO ITSELF.        The comment the bot posts is itself an event on the same
 *                                    thread. Without this the first reply triggers the second.
 *                                    This is the infinite loop, and it is one webhook away.
 *   2. NEVER TWICE TO THE SAME       Someone who was already answered and asks again is either
 *      PERSON IN A THREAD.           unsatisfied or arguing. A second automated answer to the
 *                                    same person is the bot insisting. A human takes it from
 *                                    there.
 *   3. NEVER REPLY TO THE FOUNDER.   The maintainer talking on their own repository does not
 *                                    need to be answered by their own bot, and a bot that
 *                                    interrupts the maintainer looks broken to everyone reading.
 *   4. NEVER BE THE THIRD            If the last two comments are already bot comments, a third
 *      CONSECUTIVE BOT COMMENT.      makes the thread a bot monologue. This is the backstop that
 *                                    catches loops rules 1-3 did not foresee, including two
 *                                    different bots answering each other.
 */

/** One comment in a thread, oldest first. The shape is deliberately minimal. */
export interface ThreadComment {
  /** Login of the author. Empty string when unknown — treated as unknown, never as safe. */
  readonly author: string;
  /** True when GitHub reports the author as a bot account (`type: "Bot"`). */
  readonly isBot: boolean;
  /** Comment body. Used only to recognise this bot's own disclosure line. */
  readonly body: string;
}

export interface ConversationContext {
  /** The surface this event came from. */
  readonly surface: 'issue' | 'issue_comment' | 'discussion' | 'discussion_comment' | 'pr_comment';
  /** Login of whoever wrote the thing the bot would be replying to. */
  readonly triggeredBy: string;
  /** Is that author a bot account? */
  readonly triggeredByIsBot: boolean;
  /** Every comment already on the thread, OLDEST FIRST. Excludes the triggering comment. */
  readonly comments: readonly ThreadComment[];
  /** Logins the bot must never reply to — the maintainers. Compared case-insensitively. */
  readonly maintainers: readonly string[];
  /** Is the thread closed/locked/answered? */
  readonly closed: boolean;
}

export type ReplyDecision =
  | { reply: true }
  | { reply: false; reason: ReplyRefusal };

export type ReplyRefusal =
  | 'thread_closed'
  | 'author_is_bot'
  | 'author_is_maintainer'
  | 'already_answered_this_person'
  | 'would_be_third_consecutive_bot_comment'
  | 'unknown_author'
  | 'unsupported_surface';

/** The marker every comment this bot writes carries. Used to recognise its own voice. */
export const BOT_DISCLOSURE_MARKER = 'Automated triage';

const SUPPORTED: ReadonlySet<ConversationContext['surface']> = new Set([
  'issue', 'issue_comment', 'discussion', 'discussion_comment', 'pr_comment',
]);

const eq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Is this comment one THIS bot wrote? A bot comment without the marker is some other bot. */
export function isOwnComment(c: ThreadComment): boolean {
  return c.isBot && c.body.includes(BOT_DISCLOSURE_MARKER);
}

/**
 * The whole decision, in the order that matters. Cheapest and most absolute first, so a refusal
 * is attributed to the strongest reason that applies rather than to whichever check ran first.
 */
export function shouldReply(ctx: ConversationContext): ReplyDecision {
  // 0. A surface this does not understand is not a surface it may speak on.
  if (!SUPPORTED.has(ctx.surface)) return { reply: false, reason: 'unsupported_surface' };

  // 1. Closed, locked or resolved threads are somebody's conclusion. Do not reopen them.
  if (ctx.closed) return { reply: false, reason: 'thread_closed' };

  // 2. An author the API did not name cannot be checked against rules 2 or 3, so it fails closed.
  //    An empty login is exactly what a deleted account looks like.
  if (!ctx.triggeredBy.trim()) return { reply: false, reason: 'unknown_author' };

  // 3. NEVER REPLY TO A BOT, which includes itself. `isBot` covers GitHub Actions, Dependabot,
  //    and any other automation; the marker check is not needed here and would be weaker, since
  //    a different bot answering ours is still a loop.
  if (ctx.triggeredByIsBot) return { reply: false, reason: 'author_is_bot' };

  // 4. NEVER REPLY TO A MAINTAINER.
  if (ctx.maintainers.some((m) => eq(m, ctx.triggeredBy))) {
    return { reply: false, reason: 'author_is_maintainer' };
  }

  // 5. NEVER TWICE TO THE SAME PERSON IN A THREAD.
  //
  //    "Already answered this person" means: this bot posted a comment at some point AFTER this
  //    person's first comment in the thread. Anything else would let a single earlier bot comment,
  //    addressed to somebody else entirely, permanently silence the bot for every later
  //    participant — which is the opposite failure and just as bad on a busy thread.
  const firstFromPerson = ctx.comments.findIndex((c) => eq(c.author, ctx.triggeredBy));
  if (firstFromPerson >= 0) {
    const botSpokeAfterThem = ctx.comments
      .slice(firstFromPerson + 1)
      .some((c) => isOwnComment(c));
    if (botSpokeAfterThem) return { reply: false, reason: 'already_answered_this_person' };
  }

  // 6. NEVER BE THE THIRD CONSECUTIVE BOT COMMENT.
  //
  //    Counted over ANY bot, not just this one. Two bots answering each other is still a monologue
  //    from a reader's point of view, and this rule exists to catch the loops the rules above did
  //    not anticipate.
  let trailingBots = 0;
  for (let i = ctx.comments.length - 1; i >= 0; i--) {
    if (ctx.comments[i]?.isBot) trailingBots++;
    else break;
  }
  if (trailingBots >= 2) {
    return { reply: false, reason: 'would_be_third_consecutive_bot_comment' };
  }

  return { reply: true };
}

/** Human-readable, for the run log. A refusal nobody can interpret is a refusal nobody trusts. */
export function explainRefusal(r: ReplyRefusal): string {
  switch (r) {
    case 'thread_closed': return 'the thread is closed, locked or already answered';
    case 'author_is_bot': return 'the author is a bot — replying would be a loop';
    case 'author_is_maintainer': return 'the author is a maintainer of this repository';
    case 'already_answered_this_person':
      return 'this bot has already answered this person in this thread';
    case 'would_be_third_consecutive_bot_comment':
      return 'the last two comments are already from bots — a third would be a monologue';
    case 'unknown_author': return 'the author could not be identified, so no rule could be applied';
    case 'unsupported_surface': return 'this event surface is not one the bot answers on';
  }
}
