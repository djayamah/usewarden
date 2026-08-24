# Git awareness — what usewarden can and cannot see

`scope.allowed_paths` allows every write inside your repository. That is what makes usewarden
usable, and it is also a hole: the
[documented incident in anthropics/claude-code#53900](https://github.com/anthropics/claude-code/issues/53900)
destroyed a file that was *inside* the project and had never been committed. Scope cannot tell the
difference between overwriting a committed file — one `git checkout` away — and overwriting one
whose only copy is the bytes on disk.

`scope.protect_uncommitted` closes that. It is on by default.

## The rule, exactly

An agent request to **replace a whole file** is refused when all of these hold:

| | |
|---|---|
| the tool is a whole-file write | `Write`, not `Edit` |
| the file already exists | creating a new file destroys nothing |
| it is inside a git work tree | no repository means no answer, and no answer means no verdict |
| git could not restore it | it is untracked-and-not-ignored, or its contents differ from the index |
| **this session did not write it** | the agent may always rewrite a file it created itself |

The last row is the one that makes the rule liveable. An agent's own first write makes a file
dirty, so a guard that only asked "is this file recoverable" would refuse the agent's *second*
write to its *own* file — blocking normal work within one turn of being installed. What is being
protected is work the agent did not do. `usewarden` answers that from the session's own event
history, asked before the incoming event is recorded.

## Why it blocks rather than warns

A warning on a `PreToolUse` event allows the call. The file is gone and the incident card says we
watched it happen. `checkpoint.auto` does not help either: it tags `HEAD`, which is exactly the
work that was already safe.

The block is not a dead end. The message names the one command that makes the operation safe, and
in both live sessions that proved it the agent ran it and continued:

```
Usewarden: src/todos.js has uncommitted changes that git cannot restore. Replacing the whole
file would discard them. Stage or commit them first (`git add src/todos.js`), or make a targeted
edit that keeps what is already there.
```

**Staging is enough, and that is deliberate — with a caveat worth knowing.** `git add` puts the
old contents in git's object store, where the index keeps them reachable, so `git show :src/todos.js`
recovers them. That is genuinely recoverable and it is a far better position than "gone in the next
tool call". It is *weaker* than a commit: once you stage over that path again, the old blob becomes
unreachable and a later `git gc` can prune it. So an agent can clear this guard by itself. What it
cannot do is clear it silently — the block is recorded as an incident either way, and you see it.

## What it cannot see

Every one of these returns "I do not know", and usewarden does not fire on "I do not know". They
make the guard **miss**, never make it fire wrongly.

| Not handled | Consequence |
|---|---|
| index format **version 4** (prefix-compressed paths) | the whole guard is off for that repository |
| **sha256** object-format repositories | same |
| **split index** (`core.splitIndex`) | same |
| `core.excludesFile` — your *global* ignore file | a file ignored only globally reads as untracked, so a whole-file overwrite of it is refused |
| a file larger than 8 MB whose stat changed but whose size did not | reported as unknown rather than hashed on the hot path |
| deletion or truncation through a **shell command** (`rm`, `: > file`) | out of scope; see the false-positives page for why a rule on `>` is unlivable |

The global-ignore row is the only one that can cost you a false positive, and it costs at most one
per file: stage it once, or add the pattern to the repository's own `.gitignore`.

## Why it reads git's files instead of running git

`docs/THREAT-MODEL.md` T-05 says usewarden never builds a subprocess out of event data, and
`tests/sabotage/suite.test.ts` greps `src/` for `exec(`, `execSync` and `shell: true` to prove it.
`git status --porcelain -- <path>` would put an agent-supplied path on a command line on the
hottest path in the product. So `src/engine/gitstate.ts` parses `.git/index` and the ignore files
directly, the way the branch check already reads `.git/HEAD`.

A reimplementation of part of git is only worth trusting if it is tested against git.
`tests/gitstate.test.ts` builds real repositories, asks `git status --porcelain --ignored -uall`
what *it* thinks, and requires our answer to equal git's for every path. Git is the oracle.

## Turning it off

```yaml
scope:
  protect_uncommitted: false
```

Only in **your** policy. A `usewarden.yaml` arriving inside a repository you cloned cannot turn it
off — that is a widening, and widenings from untrusted policy files are refused and reported
(SPEC-BUILD 3A.5). A repository you just cloned does not get to decide that your uncommitted work
is expendable.
