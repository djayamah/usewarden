# Changelog

All notable changes to `usewarden`.

The format is loosely [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semver](https://semver.org/). Entries before 0.1.2 are reconstructed from `DECISIONS.md` and the
git history — this file was started at 0.1.2 and says so rather than pretending it was always here.

---

## [0.1.2] — unreleased

**Two security fixes and one new control. If you run 0.1.0 or 0.1.1, the first item below is the
reason to upgrade.**

### Fixed

- **A dangerous command hidden inside a quoted program string was ALLOWED.**
  `sh -c 'rm -rf /'` was allowed by 0.1.0 and 0.1.1, and so were 43 other wrappers of the same
  shape: `env sh -c`, `nice sh -c`, `timeout 5 sh -c`, `nohup`, `setsid`, `stdbuf`, `xargs sh -c`,
  `find -exec sh -c`, `ssh host '…'`, `perl -e`, `node -e`, `eval`, and more. The bare command
  (`rm -rf /`) was correctly refused throughout; only the wrapped forms escaped.

  **The mechanism.** A rule marked `outsideRepoOnly` is skipped when every filesystem-looking
  argument of the command resolves inside `allowed_paths`. The tokenizer strips quotes, so
  `-c 'rm -rf /'` arrived as one token, `rm -rf /`, which was then resolved *relative to the
  repository* into `<repo>/rm -rf /` — a path inside the allowed scope. Every argument looked
  in-scope, so the recursive-delete rule was never evaluated.

  **The fix, in two independent parts.** The effective program is now resolved by walking past any
  runner prefix (`env`, `nice`, `timeout`, `nohup`, `setsid`, `flock`, `chroot`, `sudo`, `find`,
  `xargs` and the rest), so a shell hidden behind one is still recognised as a shell; and any
  argument token containing whitespace is refused classification outright, because a token with a
  space in it is a program string and not a path this check should trust.

  Measured against the tarballs published to npm rather than against a local build: 44 of 55
  wrapped forms allowed on 0.1.1, 0 after this fix, with no change to precision or coverage on the
  frozen 92-block label set. Evidence in `verification/escape-class-2026-09-08/`.

- **`rm -rf` of an in-repo directory whose *name contains a space* is now refused.** The one
  measured cost of the whitespace fence above, recorded here rather than left to be discovered.
  Reading and writing such a directory are unaffected; only the recursive delete is caught.

### Added

- **`usewarden` now watches its own policy.** Every check usewarden had watched the *agents'* hook
  registrations. None of them watched the rules those hooks enforce — so a policy that had been
  narrowed went unreported for ten days on the author's own machine while `status` said PROTECTED
  and `doctor` passed every row.

  The policy is now **sealed** at `usewarden init` (a verbatim copy, not a hash, because a hash
  cannot be replayed), and `status`, `doctor`, the status line and the new
  `usewarden policy --drift` report when the rules in force would catch **less** than the rules you
  installed. It is a comparison of verdicts, not a diff of the file: both rulesets are run against
  a probe set derived from them and against every incident in your own record, and the report names
  what stopped being caught. A policy that was made *stricter* is not reported as drift, and
  `usewarden reseal` accepts a change you made on purpose.

  Three findings are separated rather than blended: real blocks on this machine that would no
  longer happen, installed protections that no longer fire, and protections **downgraded** from
  absolute (`forbidden_paths`, which holds everywhere) to conditional (`allowed_paths`, which holds
  only while you are standing in the right project). The third is the one a block-count misses.

- **`usewarden reseal`** — accept the policy in force as the new baseline.
- **`usewarden policy --drift`** — the full list behind the one-line finding in `status` and
  `doctor`. Exits 1 when the policy is weaker.
- **`usewarden replay`** is documented in the README command table. It shipped in the tree but was
  never listed.

### Changed

- `README.md` now states plainly that usewarden's own policy file is writable from the shell, that
  this happened, and that detection rather than prevention is the answer a hook can give. The npm
  package page is frozen at publish time, so this correction only reaches npm with a release.

---

## [0.1.1] — 2026-08-26

- Republished so the npmjs.com package page would stop saying "Not on npm yet". There is no
  `npm readme` command and no registry API for the field, so a version bump is the only route
  (D-239). No code changes.

## [0.1.0] — 2026-08-26

- First real release. Layer 1 (deterministic rules), Layer 2 (sampled drift judge), the incident
  record, `init` / `status` / `doctor` / `scan` / `week` / `demo` / `backup`, and hook adapters for
  Claude Code, Cursor, Gemini CLI, GitHub Copilot CLI, Codex CLI and OpenCode.

## [0.0.0] — 2026-08-21

- Name placeholder, published to hold the package name. Not functional.
