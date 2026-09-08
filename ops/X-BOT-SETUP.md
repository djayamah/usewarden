# X bot — exactly what you do to connect it

> **The bot is built and NOT connected.** No account has been created, no API key requested, no
> post sent. Everything below is yours to do, and none of it should be done in a hurry.

## Before anything: read this constraint

Research on **2026-08-20** found that secondary sources summarising X's automation rules say
**keyword-triggered auto-replies are not permitted**, while scheduling, AI drafting and bulk
uploading original content are. A bot that replies the instant it is mentioned is, on the
strictest reading, a keyword-triggered auto-reply.

**X's own policy pages could not be read to confirm this** — `help.x.com` returned 403 and
`developer.x.com` returned 402 to the tool used. So this is recorded as *unverified from the
primary source*, and the bot is built to the strictest reading: **`AUTO_POST = false`, and it
writes drafts for you to send.**

**Your step 1 is to read the actual policy yourself**, logged in, at
<https://help.x.com/en/rules-and-policies/x-automation> and in the developer agreement. If it
permits replying to direct mentions, you can flip `AUTO_POST` in `bots/x/src/policy.ts`. If it
does not, leave it — the bot is useful as a drafter.

## Cost, so it is not a surprise

X moved to **pay-per-use as the default for new developers in February 2026**; Basic and Pro are
closed to new signups. Reported rates: **$0.015 per post created, $0.20 if the post contains a
link, $0.005 per post read**, no monthly minimum. *These are from secondary sources for the same
reason as above — confirm them in the developer portal before you enable anything.*

A link in every reply is the expensive case. At $0.20 per linked post, 100 replies a month is
$20. That is the number to decide against, and it is an argument for the bot drafting a reply you
send from the app rather than posting through the API at all.

## What you do

1. **Read the automation policy**, logged in. Note the date you read it.
2. **Create the account.** Handle: `@usewarden` if free. It must be a *new* account, not your
   personal one — the bot must never have credentials that can post as you.
3. **Set the profile bio.** Draft below. It must say it is automated.
4. **Set the automated-account label.** X provides a first-party way to declare an account as
   automated and to name the human who runs it: *Settings → Your account → Account information →
   Automation*. Set it, and set yourself as the managing account. This is not optional and it is
   the single cheapest thing you can do to stay on the right side of enforcement.
5. **Apply for API access** in the developer portal. Bot and AI use cases trigger an extra review,
   so describe it accurately: *replies only to direct mentions and to replies on its own posts,
   with quoted documentation and a citation; never posts unprompted; never follows, likes or
   reposts.* An accurate description is also the one most likely to be approved.
6. **Put the credentials in this machine's Keychain**, never in a file:
   ```bash
   security add-generic-password -s usewarden-x-bearer -a "$USER" -w
   ```
   Paste at the prompt. Nothing in this repository will ever print it.
7. **Run it in draft mode and read the drafts.** For at least a week. If any draft is one you
   would not have sent, tell me and the rule that produced it gets fixed.
8. **Only then** consider `AUTO_POST`, and only if step 1 said you may.

## The bio, to paste

```
Automated account for usewarden — a local guardrail for AI coding agents.
Replies only to mentions, always with a link to the source it is quoting.
Run by @<your handle>. Not a person. Issues → github.com/djayamah/usewarden
```

83 characters of that is the disclosure, deliberately in the first line.

## What the bot will and will not do

**Will**, and only these two:
- reply to a post that mentions `@usewarden`;
- reply to a reply on one of its own posts.

**Will never** — enforced in code, with a test that asserts none of these is even implemented:
follow, unfollow, like, repost, quote-post, bookmark, DM, block, mute, reply into a thread it was
not mentioned in, reply to a trending topic, post unprompted, or reply twice to the same post.

Every reply carries `🤖 automated reply` in the post itself, not only in the bio, and quotes a
repository file with a link. Same rule as the GitHub bot: **it quotes the repository or it
declines.** It never composes a claim about the product.

## Turning it off

Delete the Keychain entry. The bot cannot authenticate and stops. There is no other state.
