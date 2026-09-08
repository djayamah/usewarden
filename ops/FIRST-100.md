# FIRST 100 USERS — what will break, and what to say

Written 2026-08-20 by walking the whole path by hand in a fresh `HOME`, from a real `npm pack`
tarball: install → status → init → demo → a real hook invocation → status → uninstall →
restore-configs, plus the things a user does that the happy path does not cover.

Six things broke or confused. **Five were fixed during the walk**; the sixth is a documentation
answer rather than a code change. The fixes are listed so you know what a user on an older
version will hit.

---

## What the walk found

| # | What happened | Status |
|---|---|---|
| 1 | `usewarden status` before `init` printed UNPROTECTED, an empty table, four empty checkboxes, and exited 1 — **without saying what to do next** | **fixed** — the checklist now names the command that finishes the first unfinished item |
| 2 | `usewarden init` with no agent installed printed six absolute paths and stopped | **fixed** — it now says why, lists what it looked for with agent names, and offers `--project` |
| 3 | Every box in the CLI **broke words in half**: `send it t` / `o.`, `executes un` / `reviewed`, `Pu` / `sh to a feature branch` | **fixed** — wrapping backs off to a word boundary; long paths still hard-split |
| 4 | Moving from a local install to a global one made `status` report **TAMPERED — "Something rewrote it. Inspect immediately."** Nothing had rewritten anything | **fixed** — a registered path that is absent *and looks like a usewarden install* is now UNPROTECTED with a one-command fix. A path that does not look like one is still TAMPERED |
| 5 | `usewarden doctor` printed **`PASS  Claude Code: entries unmodified`** with the words "Something rewrote it. Inspect immediately." in the same row | **fixed** — every doctor row now carries its own message. Three rows had been sharing the agent's worst-case text |
| 6 | `npm uninstall usewarden` leaves the hook entries registered, pointing at a deleted file | **not a code change** — see Q3 |

Finding 5 is the one worth pausing on. A green row whose text describes an emergency is the exact
failure this product exists to catch, in the command people paste into issues.

---

## The five failures most likely to arrive as issues, and the exact answer to each

Each answer is written to be pasted. They cite files a reader can open.

---

### Q1. "It says UNPROTECTED and I just installed it"

**Why it happens.** `usewarden status` reports what is true *right now*, and installing the npm
package does not register anything with your agent. Registration is `usewarden init`, and it is a
separate step on purpose: it edits your agent's config file, and nothing should do that to you
without showing you the diff first.

**Answer to paste:**

> Installing the package doesn't register anything yet — that's `usewarden init`, and it's kept
> separate because it edits your agent's config file and shows you the exact diff before it
> writes anything.
>
> ```bash
> usewarden init
> ```
>
> If it says **"No AI coding agents detected"**, usewarden looked for a config directory for each
> supported agent and found none — the output lists every path it checked. Most often the agent
> is installed under a different HOME (a container, `sudo`, a different user) than the one you ran
> `init` from.
>
> If `init` succeeded but `status` still says UNPROTECTED, please paste the output of:
>
> ```bash
> usewarden doctor
> ```
>
> It checks each link in the chain separately and names the one that is broken. It never prints a
> file's contents, so it is safe to paste.

---

### Q2. "It says TAMPERED and I didn't touch anything"

**Why it happens.** Three causes, in descending order of likelihood, and only the third is
alarming:

1. **usewarden moved.** You switched between a local (`node_modules`) and a global install,
   reinstalled `node_modules`, or deleted the project you first ran `init` in. Versions after
   this walk report that as UNPROTECTED with a one-line fix instead of TAMPERED. Earlier
   versions said TAMPERED and told you to inspect the file immediately, which was a false alarm
   and is fixed.
2. **You edited your own agent config**, and usewarden noticed the bytes changed. That is the
   check working; it just cannot tell your edit from anyone else's.
3. **Something really did rewrite the entry** to run a different command.

**Answer to paste:**

> TAMPERED means the hook entries on disk no longer match what usewarden recorded when it
> registered them. Three things cause it, and only one is bad news.
>
> First, run:
>
> ```bash
> usewarden doctor
> ```
>
> **If it says the registered path no longer exists** — usewarden moved. That happens when you
> switch between a local and a global install, reinstall `node_modules`, or delete the project you
> first ran `init` in. Nothing was rewritten; the fix is to re-register:
>
> ```bash
> usewarden init
> ```
>
> **If you edited your own agent config**, that is what it is reacting to. Tell it so, then
> re-baseline:
>
> ```bash
> usewarden unlock          # suppresses TAMPERED for 15 minutes
> usewarden init            # records the new state as the baseline
> usewarden lock
> ```
>
> **If neither of those is true**, open `~/.claude/settings.json` (or your agent's equivalent —
> `doctor` prints the path) and look at the entries tagged `"_usewarden": true`. Every one should
> run your node binary against usewarden's own `cli.js` and nothing else. If one runs something
> else, that is worth reporting privately through
> [the advisory form](https://github.com/djayamah/usewarden/security/advisories/new) rather than
> as a public issue.

---

### Q3. "I removed the npm package and now my agent prints errors on every tool call"

**Why it happens.** This is the sharpest edge in the product and it will absolutely arrive.
`usewarden init` writes an **absolute path** into your agent's config — that is deliberate, and
it is a security property: a hook that resolves through `PATH` can be hijacked by anything that
puts itself earlier on `PATH`. The cost is that removing the package leaves the config pointing at
a file that is gone.

The agent then fails that hook on every tool call. Depending on the agent you get an error on
each call, or silence — and in every case **you are no longer protected**.

Deleting `node_modules` does the same thing. So does deleting the project you first ran `init` in,
if you registered at the user level from inside it.

**Answer to paste:**

> This is a real sharp edge and it is on us to make it harder to hit.
>
> `usewarden init` writes the absolute path to usewarden's own file into your agent's config. That
> is deliberate — a hook that resolves through `PATH` can be hijacked by anything that puts itself
> earlier on `PATH` — but it means removing the package leaves the entry pointing at a file that no
> longer exists.
>
> **The order matters.** Unregister first, then remove the package:
>
> ```bash
> usewarden uninstall          # removes the hook entries from every agent config
> npm uninstall -g usewarden   # or: npm uninstall usewarden
> ```
>
> **If you already removed the package**, reinstall it, unregister, then remove it again:
>
> ```bash
> npm install -g usewarden
> usewarden uninstall
> npm uninstall -g usewarden
> ```
>
> **If you would rather not reinstall**, delete the entries by hand. In `~/.claude/settings.json`
> (or your agent's config) every entry usewarden added is tagged `"_usewarden": true`. Removing
> those objects, and any now-empty `hooks` block that only ever held them, restores the file.
> `usewarden uninstall` does exactly this and nothing else.
>
> Your original config was backed up before the first write, under `~/.usewarden/backups/`, with a
> timestamp. `usewarden restore-configs` puts one back byte-for-byte.
>
> **A note on which install to choose.** A global install (`npm install -g usewarden`) is the one
> to prefer. A local install puts usewarden's path inside one project's `node_modules`, and
> `usewarden init` registers with your agent for the *whole machine* — so an ordinary
> `rm -rf node_modules` in that one project silently unprotects every project you have.

---

### Q4. "It's blocking something completely normal"

**Why it happens.** The default policy is deliberately strict, and over-blocking is treated as a
real defect here, not as the tool working. But the first thing to establish is *which rule fired*,
because the answer is different for each.

**Answer to paste:**

> Over-blocking is a real defect in usewarden's book, not the tool doing its job — the README's
> own security posture section says a guardrail that leaves you unable to work is a failure. So
> this is worth reporting, and there is something you can do right now.
>
> First, find out which rule fired:
>
> ```bash
> usewarden incidents
> ```
>
> Every card names the exact policy line — `scope.forbidden_paths[5]`, `commands.deny[3]`, and so
> on. That is the line to change.
>
> To widen scope for a directory, edit `~/.usewarden/usewarden.yaml` and add it to
> `scope.allowed_paths`. To stop a command rule firing, remove or narrow that entry in
> `commands.deny`. Then:
>
> ```bash
> usewarden policy
> ```
>
> which prints the effective policy and where each part came from, so you can confirm your change
> is the one taking effect.
>
> If you need to get unblocked immediately while you work out the right rule:
>
> ```bash
> USEWARDEN_ALLOW_CONFIG_WRITE=1 ...        # for usewarden's own self-protection
> ```
>
> and for a policy rule, comment it out of `usewarden.yaml` — Layer 1 reloads on the next event,
> so there is nothing to restart.
>
> **Please still open an issue with the incident card.** A rule that fires on ordinary work is
> worth fixing for everyone, and the card contains the rule and the attempted action without ever
> containing a credential value.

---

### Q5. "Does this send my code anywhere / do I need to pay for an API key?"

**Why it happens.** It is the first thing anyone sensible asks about a tool that watches
everything their agent does. It was also the very first real issue this project received, and the
answer needs to be short and checkable rather than reassuring.

**Answer to paste:**

> Short answer: no to both.
>
> **Nothing leaves your machine.** Layer 1 — the part that does the blocking — is entirely local
> pattern and scope matching. Telemetry is off by default and this version ships **no endpoint at
> all**, so there is nowhere for a payload to go even if one were built. The full detail, including
> the exact payload schema it *would* record if you opted in, is in
> [docs/TELEMETRY.md](https://github.com/djayamah/usewarden/blob/main/docs/TELEMETRY.md), and you
> can see it locally with `usewarden telemetry status`.
>
> **No API key, and no cost.** Layer 1 needs no key and consumes zero tokens; it catches 15 of the
> 17 scenarios in the project's own sabotage suite on its own. Layer 2 — the semantic drift judge —
> is optional and you bring your own key. It will also use an already-authenticated `claude` or
> `gemini` CLI if one is on your PATH, which costs nothing extra. With nothing configured, Layer 2
> announces that it is off and Layer 1 runs unchanged.
>
> The one thing that can ever leave your machine is a Layer 2 judge call you switched on yourself,
> to a provider you chose, with your own key — and its input is redacted and length-capped first.

---

## Two more things worth knowing before the traffic arrives

**`usewarden status` exits 1 when unprotected.** That is correct and deliberate — it is what makes
it usable in a shell prompt or CI — but someone will report it as a bug on a fresh install, where
exiting non-zero before `init` is the expected state. The answer is Q1.

**Writing ABOUT a dangerous command is blocked too.** The `commands.deny` rules match the whole
command string, so an agent writing a commit message, a README paragraph, or an issue reply that
*mentions* a destructive command is blocked from writing it — even inside a quoted heredoc the
shell would never execute. This happened during the walk: a commit whose message described this
very problem was refused. It fails safe, which is the right direction, but for a tool whose users
are agents writing about their own tooling it is not an edge case. The workaround is to put the
text in a file and pass that file to the command (`git commit -F message.txt`). Tracked as D-139.

**The default policy blocks `rm -rf` outside the repository.** During this walk it blocked a
`rm -rf` against a temp directory that had nothing to do with any project. That is the rule
working as designed and it will read as over-blocking to someone cleaning up scratch files. It
falls under Q4, and the incident card names `commands.deny` so the reporter can see exactly which
rule to narrow.

---

## What was not walked

Stated so nobody reads this as more coverage than it is:

- **Only Claude Code.** Gemini CLI, Cursor, Copilot CLI, Codex CLI and OpenCode were not part of
  this walk. Three of those have never been watched running at all and the README labels them
  UNVERIFIED-LOCALLY.
- **macOS only.** No Linux, no Windows, no WSL, no container.
- **The hook was invoked directly**, with the exact payload Claude Code sends, rather than by
  launching a real agent session. Live agent sessions are covered separately in
  `verification/live/`, and they are the ones that have historically found the real defects.
