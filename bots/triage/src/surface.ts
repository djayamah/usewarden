import { type ConversationContext } from './conversation.js';

/**
 * WHICH SURFACES THE BOT IS TURNED ON FOR — a second switch, deliberately separate from the first.
 *
 * `shouldReply()` decides whether the bot may speak in a given *conversation*. This file decides
 * whether it may speak on a given *surface at all*, and the two are not the same question. The
 * conversation guard is a safety property proven by tests; this is a rollout control owned by the
 * founder, and it exists because of a specific hazard in shipping the two together:
 *
 *   `TRIAGE_BOT_ENABLED` is already set on the public repository. If wiring the new triggers also
 *   activated them, then merging this code would silently change the bot's behaviour on a live
 *   repository — from "comments once on new issues" to "participates in every discussion" — with
 *   no separate decision by anyone. A merge is not a decision to widen a bot's reach.
 *
 * So the default is `issues` and only `issues`: exactly what the bot did before this change. The
 * new surfaces do nothing until someone sets the variable, and an unparseable or empty value falls
 * back to the default rather than to everything.
 *
 * Fail-closed matters more than convenience here. `TRIAGE_BOT_SURFACES=all` is deliberately NOT
 * supported — a wildcard is how a surface nobody evaluated gets enabled by a value someone typed
 * once. Each surface has to be named.
 */

export type Surface = ConversationContext['surface'];

/** Every surface the bot has code for. Naming one here does not enable it. */
export const KNOWN_SURFACES: readonly Surface[] = [
  'issue', 'issue_comment', 'discussion', 'discussion_comment', 'pr_comment',
] as const;

/** What the bot does with no configuration: exactly what it did before the wider surface existed. */
export const DEFAULT_SURFACES: readonly Surface[] = ['issue'] as const;

/**
 * Parse `TRIAGE_BOT_SURFACES`. Comma or space separated, case-insensitive.
 *
 * Anything unrecognised is DROPPED and reported by the caller rather than silently tolerated, and
 * a value that yields no known surface at all returns the default — never an empty set, because an
 * empty set would disable the bot through a typo in a variable whose purpose is to widen it, which
 * is a confusing way to be off. Being off is what `TRIAGE_BOT_ENABLED` is for.
 */
export function parseSurfaces(raw: string | undefined): { surfaces: Surface[]; unknown: string[] } {
  const tokens = (raw ?? '').split(/[,\s]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (tokens.length === 0) return { surfaces: [...DEFAULT_SURFACES], unknown: [] };

  const surfaces: Surface[] = [];
  const unknown: string[] = [];
  for (const t of tokens) {
    const match = KNOWN_SURFACES.find((s) => s === t);
    if (match) { if (!surfaces.includes(match)) surfaces.push(match); } else unknown.push(t);
  }
  // A line that named only nonsense is a misconfiguration, not an instruction to widen. Fall back.
  if (surfaces.length === 0) return { surfaces: [...DEFAULT_SURFACES], unknown };
  return { surfaces, unknown };
}

/**
 * Map a GitHub Actions `event_name` + `action` to a surface, or null if it is not one we answer on.
 *
 * `issue_comment` fires for pull-request comments too — GitHub models a PR as an issue — and the
 * two are told apart by whether the payload carries `pull_request`. They are different surfaces
 * here because they are different rooms socially, and a maintainer may reasonably want the bot in
 * one and not the other.
 */
export function surfaceFromEvent(
  eventName: string, isPullRequest: boolean,
): Surface | null {
  switch (eventName) {
    case 'issues': return 'issue';
    case 'issue_comment': return isPullRequest ? 'pr_comment' : 'issue_comment';
    case 'discussion': return 'discussion';
    case 'discussion_comment': return 'discussion_comment';
    default: return null;
  }
}
