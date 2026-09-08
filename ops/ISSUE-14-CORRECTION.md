# Issue #14: the correction, prepared and NOT posted

**The comment body is `ops/prepared/issue-14-correction.md`.** This file is the runbook: why it is
not posted, what has to be true before it is, and the one command that posts it.

---

## Why it is not posted

**One reason now, not two.** The second blocker below was real and is CLEARED — the fix is merged
and verified against the live tree. Only the scope question is left, and it is yours to answer.

### 1. An issue comment is outside the amendment you asked for

Your instruction narrowed exception 2 to *"publishing Discussions, Discussion comments, and
Releases on `djayamah/usewarden` only"*. Issue comments are not in that list, and the word "only"
is yours. `scripts/apply-amendment-discussions.sh` writes exactly what you specified, so applying
it does **not** authorise this post.

I think the reasoning you gave for Discussions reaches issue comments on the same repository
without any strain — you own the surface, you can edit or delete anything, none of the reasons
exception 2 exists apply. But that is an argument for you to widen the amendment by one word, not
for me to read the adjacent case into a list you scoped as exhaustive. Say the word and it is a
one-line change to the script.

### 2. ~~The correction is not accurate against the tree the bot reads~~ — CLEARED 2026-08-22

**This was the real blocker and it is now closed.** Merged as
[#16](https://github.com/djayamah/usewarden/pull/16) — public `main` is `3503705f78`. Kept here in
full rather than deleted, because the finding is worth more than the fix: it is D-152 and D-171 for
the THIRD time, and the pattern will recur.

**Verified on the live tree, not on this one:** `tests/bot-issue-14.test.ts` passes **9/9** against
a checkout of public `main` @ `3503705f78`, and all **25** block-quoted lines in
`ops/prepared/issue-14-correction.md` are verbatim in the live `README.md` and `docs/METRICS.md`.
The links in the correction now resolve to text that says what the correction claims.

What the problem was, measured on both trees with the same issue text and the same code:

| Corpus | Answered | Unanswered | Quotes the maintainer's aside |
|---|---|---|---|
| **public `main`** @ `648863a` — BEFORE the merge | yes | **install, use, monitor** (3 of 4) | **yes** |
| **public `main`** @ `3503705f78` — now | yes | **none** | no |
| **private `main`** — this tree | yes | none | no |

Reproduce it:

```bash
node -e "
Promise.all([import('./dist/bots/triage/src/corpus.js'), import('./dist/bots/triage/src/triage.js')]).then(([{Corpus},{triage}])=>{
  const issue={number:14,title:'Is this free or paid?',body:'Is this free or paid? Also how do I install and use and monitor the impact of this?',user:'djayamah'};
  for (const [label,root] of [['PUBLIC','.worktrees/live'],['PRIVATE','.']]) {
    const r=triage(issue,new Corpus(root));
    console.log(label, /This section exists because it was missing/i.test(r.comment) ? 'quotes the aside' : 'quotes the answer');
  }
});
"
```

Two causes, both fixed in #16: `docs/METRICS.md` opened its monitoring section with an italic aside
about the bot's own failure and the excerpt logic biases toward a section's opening, so the aside
was quoted as the answer; and the install question had no answer on the public tree at all, because
a question-headed section outranked the one that answers it (D-183).

The ordering mattered and was observed: posting the correction first would have been a correction
whose own citations did not yet say what it claimed — the same class of mistake as the original
comment, which told a reader the documents did not cover something they did cover.

---

## What has to be true before the command below is run

- [x] The bot PR is **merged** — #16, public `main` `3503705f78`.
- [x] `tests/bot-issue-14.test.ts` passes **on the public tree**: 9/9. Re-check any time:
      ```bash
      git fetch public main
      git worktree add --detach .worktrees/check public/main
      cd .worktrees/check && npm ci --ignore-scripts && npm run build
      node --test dist/tests/bot-issue-14.test.js
      ```
- [x] Every quoted line in the correction is verbatim in the live public tree (25/25).
- [ ] **You have decided whether issue comments are inside the amendment (§1 above).** This is the
      only remaining blocker.

## The command

```bash
gh issue comment 14 --repo djayamah/usewarden \
  --body-file ops/prepared/issue-14-correction.md
```

That is the whole of it. It posts one comment on your own test issue, as you. Nothing else changes:
the bot is not re-run, no label moves, and the issue stays open.

## To close the loop afterwards

Issue #14 currently carries `question` and `unmatched`. `unmatched` is now wrong twice over — the
question is answered, and the label has been split so that a question the documents cannot answer
is `docs-gap` rather than `unmatched`. After the correction:

```bash
gh issue edit 14 --repo djayamah/usewarden --remove-label unmatched
gh issue close 14 --repo djayamah/usewarden \
  --comment 'Answered above, and pinned as a regression test. Closing.'
```

Leave `question`. It is correct and it is what the label is for.
