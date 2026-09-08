/**
 * X BOT — POLICY LAYER.
 *
 * ============================================================================================
 * BUILT. NOT CONNECTED. DRAFTS BY DEFAULT.
 * ============================================================================================
 *
 * The brief was: reply only to mentions and to replies on our own posts; never into other
 * people's threads; never auto-follow; never auto-like; official API only.
 *
 * Research on 2026-08-20 turned up a constraint that changes the shape of this, and it is
 * recorded here rather than quietly designed around:
 *
 *   Secondary sources summarising X's current automation rules state that **scheduling, AI
 *   drafting and bulk uploading original content are permitted, while keyword-triggered
 *   auto-replies are not.** A bot that posts a reply the moment it is mentioned is, on the
 *   strictest reading of that, a keyword-triggered auto-reply.
 *
 *   X's own policy pages could NOT be read to confirm this: help.x.com returned 403 and
 *   developer.x.com returned 402 to the fetcher used. So the constraint is recorded as
 *   UNVERIFIED-FROM-PRIMARY-SOURCE, and the design assumes the strictest reading is correct.
 *
 * Therefore `AUTO_POST` is false and the bot writes drafts to stdout for a human to send. Every
 * other rule in the brief is enforced in code regardless of that switch, so flipping it later
 * cannot accidentally widen what the bot will engage with.
 *
 * See ops/X-BOT-SETUP.md before changing this.
 */

export const AUTO_POST = false;

export type Eligibility =
  | { eligible: true; reason: 'mention' | 'reply_to_our_post' }
  | { eligible: false; reason: string };

export interface XPost {
  id: string;
  authorId: string;
  text: string;
  /** The post this one replies to, if any. */
  inReplyToId?: string;
  /** Post ids we published. */
  conversationRootAuthorId?: string;
}

export interface EligibilityContext {
  /** The bot's own numeric user id. */
  selfId: string;
  /** Ids of posts published by the account, for the reply-to-our-post case. */
  ourPostIds: Set<string>;
  /** Ids the bot has already replied to, so it never replies twice. */
  alreadyRepliedTo: Set<string>;
}

/**
 * The ONLY two things the bot may respond to. Everything else is refused with a reason, and the
 * reasons are deliberately explicit so a log makes the boundary auditable.
 */
export function isEligible(post: XPost, ctx: EligibilityContext): Eligibility {
  if (post.authorId === ctx.selfId) return { eligible: false, reason: 'our own post' };
  if (ctx.alreadyRepliedTo.has(post.id)) return { eligible: false, reason: 'already replied' };

  const mentionsUs = /@usewarden\b/i.test(post.text);
  const repliesToUs = Boolean(post.inReplyToId && ctx.ourPostIds.has(post.inReplyToId));

  if (repliesToUs) return { eligible: true, reason: 'reply_to_our_post' };
  if (mentionsUs) return { eligible: true, reason: 'mention' };

  return { eligible: false, reason: 'not a mention and not a reply to one of our posts' };
}

/** Actions the bot must never take, listed so a test can assert none of them is implemented. */
export const FORBIDDEN_ACTIONS = [
  'follow', 'unfollow', 'like', 'repost', 'retweet', 'bookmark', 'dm', 'block', 'mute',
  'search_and_reply', 'reply_to_trending', 'quote_post',
] as const;

/** Every draft carries the automated disclosure, in the post itself, not only in the bio. */
export const DISCLOSURE = '🤖 automated reply';

export const MAX_POST_CHARS = 280;

export interface Draft {
  inReplyToId: string;
  text: string;
  /** Files the quoted content came from, so a human can check before sending. */
  citations: string[];
}

/**
 * Builds a reply draft. Same rule as the GitHub bot: it quotes the repository or it declines.
 * There is no path here that composes a claim about the product.
 */
export function buildDraft(
  post: XPost,
  answer: { answered: boolean; citations: string[]; firstLine: string },
): Draft | null {
  if (!answer.answered) return null;
  const room = MAX_POST_CHARS - DISCLOSURE.length - 2;
  const cite = answer.citations[0] ?? '';
  const link = ` github.com/djayamah/usewarden/blob/main/${cite}`;
  const body = answer.firstLine.slice(0, Math.max(0, room - link.length - 1)).trim();
  return {
    inReplyToId: post.id,
    text: `${body}${link}\n${DISCLOSURE}`.slice(0, MAX_POST_CHARS),
    citations: answer.citations,
  };
}
