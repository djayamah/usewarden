# Contributing to usewarden

Thank you for considering it. This file is short and specific, because a contributing guide that
says "be nice and write tests" costs a reviewer more than it saves.

## The one rule that shapes everything else

**A green test does not mean a working guardrail.** Six defects in this project's own build made
it through a passing suite and were caught only by running a real agent against a real fixture —
they are listed in the README. So:

1. **A sabotage test must assert the sabotage landed first.** Before asserting that a defense
   caught something, assert that the dangerous thing really is present in the state under test. A
   test that passes because its setup silently failed is worse than no test.
2. **Fixtures prove a check works. Only a live session proves it fires.** If your change touches
   how a hook is registered or invoked, run it against a real agent in
   `fixtures/sandbox-project/` and attach the transcript. `scripts/live-session.sh` does this
   behind a fence that verifies the resolved working directory first.
3. **UNVERIFIED is a failure, not a pass.** If a check could not run, say so and count it against
   the total. "I could not tell" and "it is fine" are different sentences.

## Getting set up

```bash
git clone https://github.com/djayamah/usewarden && cd usewarden
npm install          # TypeScript and @types/node. There are no runtime dependencies.
npm run build
npm test             # 247 tests, no network, no API keys
```

Node **≥ 22.13.0** is required (`node:sqlite` stopped needing a flag there). CI runs Node 22 LTS,
24 LTS and 25.

Before opening a PR:

```bash
./scripts/verify-all.sh
```

That is the full local gate — clean build, strict typecheck, the suite on two Node lines, fixture
regeneration, the clean-machine simulation, screenshots rendered by a real browser, and a CLI
smoke pass. It exits non-zero if anything fails.

**CI runs a subset**, and it is worth knowing which: `npm ci --ignore-scripts`, typecheck, build
and the full test suite on Node 22, 24 and 25, plus the no-install-scripts and tarball-contents
assertions and a pattern scan over every blob in history. It does **not** run the headless-browser
screenshots, the clean-machine simulation, or anything that needs a real agent — those need a
machine, not a runner. So a green CI is necessary and not sufficient, and `verify-all.sh` before
you open the PR is the part that catches what CI cannot.

## Things that will be asked of a pull request

- **No new runtime dependencies** without a case in `docs/DEPENDENCY-BUDGET.md` — weekly
  downloads, maintenance status, transitive count, and what breaks without it. The zero-dependency
  posture is a security property, not an aesthetic (see `docs/THREAT-MODEL.md` T-01).
- **No install scripts, ever.** `preinstall`, `install`, `postinstall` and `prepare` are the
  ChainDrop mechanism. `tests/packaging.test.ts` fails if one appears in the manifest *or*
  anywhere in the lockfile.
- **No shell.** Every subprocess uses `execFile` with an argv array. There is a static test that
  scans `src/` for `shell: true`, `execSync` and `exec(`.
- **Adding an agent adapter?** It is one entry in `src/adapters/`, one row in
  `docs/HOOK-MATRIX.md`, and contract tests for its deny dialect. Mark it `UNVERIFIED-LOCALLY`
  until someone has actually run that agent against it — the matrix distinguishes "we wrote the
  adapter" from "we watched it fire", and that distinction is the point.
- **Changing a rule?** Add it to `launch/RULES-REGISTRY.md` and to the sabotage suite. Every
  default rule has a test that proves it blocks and a test that proves it does not over-block.
- **Touching the judge?** `tests/judge-providers.test.ts` asserts each provider's request shape,
  response parsing, cost accounting and fail-open behaviour against the vendor's published
  schema. If a vendor changes something, update the test in the same commit as the fix, and say
  in the PR which schema you checked it against.

## Commit and PR style

- Commit messages explain **why**, not what — the diff already says what.
- One logical change per PR. A rename plus a behaviour change in one commit is very hard to
  review and even harder to revert.
- If you found a defect by running something rather than by reading it, say so in the PR. That is
  the most useful sentence in the whole description.

## Reporting bugs

Open an issue with the template. If it is a **security** issue, do not open an issue — see
[SECURITY.md](SECURITY.md).

For anything where usewarden said **PROTECTED** but did not act, please include the output of:

```bash
usewarden doctor --json
usewarden status --json
```

Both redact paths and neither contains credentials. That pair of outputs answers most of the
questions a maintainer would otherwise have to ask.

## Code of conduct

Be straightforward and assume good faith. Technical disagreement is welcome and personal attacks
are not; maintainers may close or lock threads that stop being about the work.

## Licence

By contributing you agree that your contributions are licensed under the
[MIT Licence](LICENSE), the same terms as the rest of the project.
