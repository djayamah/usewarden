# DECISIONS

> **Historical document — not renamed.** The product was renamed from `warden` to
> `usewarden` on 2026-08-19 (see `DECISIONS.md` D-046/D-047). Every occurrence of
> "warden" below refers to the product under its old name; the shipping name is
> `usewarden` for the npm package, the binary, the CLI command, `usewarden.yaml`,
> `~/.usewarden/` and the `USEWARDEN_*` environment variables.


Format: `[decision — rationale — confidence 1-10 — what would change it]`

## Phase 0

- **[D-001] Target `engines.node: ">=22.13.0"` — rationale: Node 22 (Jod) and 24 (Krypton) are the
  only Active LTS lines as of 2026-08 (nodejs.org/en/about/previous-releases, fetched 2026-08-19);
  20 and 18 are EOL; 26 is Current. 22.13.0 is the exact version where `node:sqlite` stopped
  requiring `--experimental-sqlite`. Verified empirically: `node:sqlite` opens, WAL-enables, and
  round-trips on Homebrew node@22 v22.22.0 (`verification/phase0-node-sqlite.txt`).
  — confidence 9 — would change if a defect appears on 22.x that is absent on 24.x, in which case
  the floor moves to `>=24.0.0` and the README says so.**

- **[D-002] Use built-in `node:sqlite`, not `better-sqlite3` — rationale: spec §3 decides this, and
  §3A.1 makes it a *security* requirement rather than a preference: better-sqlite3 is a native
  addon with an install script, which is the exact ChainDrop vector (S3). `node:sqlite` is
  Stability **1.2 — Release Candidate**, documented as "stable and recommended for production
  use". — confidence 8 — would change on a blocking node:sqlite defect (data loss, WAL corruption,
  or a 22↔24 behaviour split), in which case better-sqlite3 is the documented fallback and
  `docs/DEPENDENCY-BUDGET.md` must justify the native addon explicitly.**

- **[D-003] Build-machine vs LTS-target divergence recorded: this machine runs Node v25.5.0, an
  odd-numbered Current-line release that is NOT an LTS target. Measured differences:
  (a) `require('node:sqlite')` emits an `ExperimentalWarning` on **stderr** on v25.5.0 but not on
  v22.22.0; (b) everything else tested (DatabaseSync, WAL on a file db, busy_timeout, prepare/
  run/all, db.function, db.aggregate) behaves identically on both.
  Consequence: (a) is a real hazard for hook adapters, because Claude Code and Codex surface hook
  **stderr** as the block reason and Gemini's contract is stdout-purity. Mitigation adopted:
  every warden hook entrypoint calls `process.removeAllListeners('warning')` as its first
  statement (verified to suppress the warning) and writes exactly one JSON document to stdout.
  — confidence 9 — would change if Node makes warning emission non-suppressible.**

- **[D-004] Register Codex hooks at the USER layer (`~/.codex/hooks.json`), not the project layer —
  rationale: learn.chatgpt.com/docs/hooks (fetched 2026-08-19) states project-local hooks load only
  when the `.codex/` layer is trusted and that IDE/desktop wrappers may ignore project config
  entirely. A guardian that silently does not run is this product's worst failure mode (§3B), so
  warden takes the layer with fewer silent-off conditions and documents the wrapper gap in README
  limitations. — confidence 8 — would change if Codex documents project-layer loading as
  unconditional.**

- **[D-005] Deduplicate cross-agent events by content hash, not by agent id — rationale: Cursor
  documents loading hooks from third-party tools including Claude Code, so one logical tool call
  can arrive twice on a machine with both configured. Hash over (agent-family, session, event,
  canonical tool, normalized args, 2s timestamp bucket). — confidence 7 — would change if a real
  double-fire is observed that the bucket width misses; widen the bucket and re-test.**

- **[D-006] Warden registers agent hooks with fail-OPEN semantics (Cursor `failClosed: false`,
  short explicit timeouts everywhere) — rationale: §3A.6 and the documented `claude plugin install`
  lockout in karanb192/claude-code-hooks. A warden crash must never be able to brick a user's
  agent. The cost is honest and stated in README: warden is a guardian, not a sandbox.
  — confidence 9 — would change only if a user explicitly opts into `warden --paranoid`, which is
  out of scope for v1.**

- **[D-007] ChainDrop, CVE-2025-59536, CVE-2026-21852 and CVE-2026-25725 all confirmed against
  primary/vendor sources rather than assumed from the spec — rationale: the spec asserts them and
  the build must not take that on trust. All four verified; URLs and findings recorded in
  docs/THREAT-MODEL.md S1-S5. — confidence 9 — n/a.**

## Phase 1

- **[D-008] The Layer-2 judge calls provider HTTP APIs with built-in `fetch`, not a vendor SDK —
  rationale: warden's stack decision is zero runtime dependencies, and §3A.1 makes that a
  *security* property (every dependency is a ChainDrop surface). The judge is also required to be
  provider-agnostic across Anthropic/OpenAI/Gemini, so an SDK per provider would be three
  dependencies plus their transitive trees to buy one POST each. The request bodies are pinned to
  the documented wire format and the model ids come from the current pricing table
  (`claude-haiku-4-5` at $1.00/$5.00 per 1M in/out). — confidence 8 — would change if warden ever
  needs streaming, tool use, or retries with backoff from the judge, at which point one SDK is
  cheaper than maintaining that by hand.**

- **[D-009] `min-release-age` is measured in DAYS, not minutes — discovered empirically, not
  assumed: `min-release-age=1440` made npm refuse `@types/node@^22.10.5` with "no matching version
  found ... with a date before 9/9/2022", i.e. it treated 1440 as 1440 days. Confirmed against
  docs.npmjs.com/cli/v11/using-npm/config. Set to `7` in the committed `.npmrc`. This is exactly
  the class of mistake that produces a security control which silently does nothing (here it did
  the opposite and broke the install loudly, which is the good failure). — confidence 10 — n/a.**

- **[D-010] Warden ships compiled JS in `dist/` and has NO `prepare` script, which is the
  conventional way to build on install — rationale: `prepare` is one of the four lifecycle scripts
  §3A.1 forbids outright. The build runs from an explicit `npm run build`, and
  `scripts/pre-publish-check.sh` asserts the tarball contents by hand. — confidence 9 — would
  change only if npm adds a build hook that provably cannot run on `npm install`.**

- **[D-011] `warden.yaml` is parsed by a ~200-line strict YAML *subset* parser written in-tree
  rather than by the `yaml` package — rationale: T-06. Policy files arrive from cloned untrusted
  repos, and a full YAML engine's feature surface (tags, anchors, merge keys, multi-doc) is
  attack surface warden does not need. The parser rejects each of those by name so the error is
  honest rather than a silent misparse, and it also keeps the runtime dependency count at zero.
  Cost: users cannot use advanced YAML in their policy. That is documented in the starter file.
  — confidence 8 — would change if real users hit legitimate YAML the subset rejects; the fallback
  is the `yaml` package with `JSON.parse`-equivalent safe-schema options and a DEPENDENCY-BUDGET
  entry.**

## Phase 2

- **[D-012] Hooks are registered as `<absolute node binary> <absolute warden script> hook <agent>
  <event>`, not as `<absolute warden script> ...` — rationale: found by verification, not by
  reasoning. The first live Claude Code session failed with
  `EACCES: permission denied, posix_spawn '/Users/you/dev/warden/dist/src/cli.js'` on EVERY
  hook, while `warden status` still cheerfully said PROTECTED — the exact silent-guardian failure
  §3B calls the worst one. Cause: the built script had no execute bit. Naming the interpreter
  explicitly removes three failure modes (execute bit, shebang, Windows-has-no-shebang) and keeps
  every component absolute per T-04. Cost: the recorded node path can go stale if the user
  replaces their node install; `warden doctor` checks the interpreter exists and is executable.
  — confidence 9 — would change if a vendor ever refuses a non-self command, which none of the six
  documented contracts does.**

- **[D-013] Warden registers at TWO layers, user and project, and `warden status` aggregates
  PER AGENT rather than per config file — rationale: the fixture sessions must be protected
  without warden touching the real `~/.claude/settings.json`, and repo-local registration is a
  genuinely wanted feature (a team commits it so a fresh checkout arrives guarded). Aggregation
  matters because an agent protected at the project layer is protected; reporting its
  never-registered user layer as UNPROTECTED would be a false alarm, and a guardian that cries
  wolf gets ignored, which is the same outcome as not running. TAMPERED still wins over PROTECTED
  at any layer. — confidence 8 — would change if users report confusion about which layer is
  active; the fix is to keep the aggregation and make the per-layer table louder.**

- **[D-014] `box()` wraps long content inside the frame instead of overflowing — rationale: the
  incident card is the marketing asset (§3.6) and the first real catch produced a 120-character
  command that blew the border apart. Wrapping is ANSI-aware and hangs the continuation under the
  label. — confidence 9 — n/a.**

- **[D-015] Empty flow collections (`[]`, `{}`) are accepted by the YAML subset parser —
  rationale: warden's OWN generated starter policy contains `invariants: []`, and the first
  `warden status` in the sandbox reported POLICY_INVALID against a file warden had just written.
  Empty flow collections carry no nesting, no tags and no aliases, so none of the T-06 reasoning
  applies to them. Non-empty flow style is still rejected. A test now asserts the generated
  starter policy round-trips through warden's own parser and validator. — confidence 9 — n/a.**

## Phase 3

- **[D-016] Layer 2 runs in a DETACHED child process, not inline in the hook — rationale: measured
  necessity. The judge takes seconds and a local agent CLI takes tens of seconds, while warden
  registers a 10s hook timeout and a human is waiting on the other end. Because a Layer-2 verdict
  can only ever WARN (it is sampled, fallible and prompt-injectable, so it is never permitted to
  block), it has no business on the response path. The hook now answers with the Layer-1 verdict
  immediately and forks `warden judge-run <payload-path>`; the finding lands in the same SQLite
  store seconds later and appears in `status`, `incidents` and the dashboard. Verified live: the
  detached judge recorded four drift findings across two real sessions while every hook response
  stayed instant. — confidence 9 — would change if a vendor adds a way to amend a completed tool
  call, at which point the finding could also be fed back to the agent.**

- **[D-017] Added a `local-claude` / `local-gemini` judge provider that shells out to an agent CLI
  the user has already authenticated — rationale: this machine has NO `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY` or `GEMINI_API_KEY`, and the credentials rule forbids me obtaining one. Without
  this provider Phase 3 could only ever have been mocked. It is also the right product decision:
  most developers who would install warden have `claude` or `gemini` on PATH and no exported API
  key, so an API-key-only Layer 2 would ship switched off for the majority of users.
  Recursion safety is threefold - the child is launched with hooks disabled, `WARDEN_JUDGE_CHILD=1`
  makes warden refuse to judge inside a judge, and the spawn is execFile with a fixed argv.
  Accounting honesty: these calls consume real subscription quota but yield no token counts, so
  warden reports them as an unmetered COUNT and never invents a dollar figure. — confidence 8 —
  would change if CLI invocation proves too slow or too flaky in the field; the fallback is
  API-key-only Layer 2 with a clear "set a key to enable drift detection" message.**

- **[D-018] Judge-testing API spend stands at $0.00 of the $15.00 limit and is expected to stay
  there — rationale: no metered provider is reachable on this machine and the credentials rule
  forbids obtaining one. Layer 2 is verified live through the local-CLI provider and hermetically
  through 25 mocked tests. The metered HTTP paths (Anthropic / OpenAI / Gemini) are therefore
  marked **DEFERRED-COST**: their request shapes are built to the documented wire format and
  exercised by unit tests, but no live metered call has been made. — confidence 10 on the fact,
  7 on the metered wire formats being byte-correct — would change if a key becomes available;
  one call per provider (well under $0.01) would settle it.**

- **[D-019] Multi-line commands are collapsed to one display line with a visible pilcrow before
  being stored — rationale: a live catch recorded a heredoc and the rendered incident card tore
  apart across the frame. Found by looking at the artifact, not by a test; a regression test now
  covers it. — confidence 9 — n/a.**

## Phase 4

- **[D-020] Dashboard screenshots use the `chrome-headless-shell` already present on this machine,
  not a Puppeteer or Playwright devDependency — rationale: both of those ship postinstall scripts
  that download a browser, which is precisely the install-script surface T-01 refuses. Adding one
  to prove a security product is secure would be self-defeating. `scripts/screenshot.sh` probes a
  short list of known locations and FAILS LOUDLY when none is found rather than silently skipping
  the screenshot step. — confidence 9 — would change on a CI machine with no browser; the fix is
  a documented, pinned, script-free browser download in CI, not a devDependency.**

- **[D-021] The dashboard accepts an explicit `?theme=dark|light` override — rationale: found by
  looking. A headless browser ignores `--force-dark-mode` for `prefers-color-scheme`, so the first
  "dark" and "light" screenshots came out byte-identical and proved nothing. The override makes
  both palettes deterministically capturable, and is validated against an allowlist so a hostile
  value cannot reach the `<html>` tag. — confidence 9 — n/a.**

- **[D-022] `warden status` reports on every layer warden has EVER registered, not only the one
  belonging to the current directory — rationale: found by looking at the first dashboard
  screenshot, which said UNPROTECTED in red while three project-layer hooks were installed and
  working, purely because the dashboard process happened to be started from the repo root.
  Protection state that depends on your shell's cwd is worse than useless in a guardian. Status
  now seeds its layer list from the recorded integrity rows. — confidence 9 — n/a.**

- **[D-023] `warden demo` records incidents with `live = 0` and says so on screen — rationale:
  the activation metric (§3B) is "warden caught something in a REAL session". If the demo ticked
  that box the metric would measure nothing. The demo prints the distinction explicitly so the
  user is not confused by an untick after four visible blocks. — confidence 10 — n/a.**

## Phase 5

- **[D-024] Hook `timeout` is registered in each vendor's OWN unit, from a per-agent table —
  rationale: found by a live Gemini CLI session, not by reading. Warden registered `timeout: 10`
  everywhere; Gemini logged `Hook timed out after 10ms` on every single event while
  `warden status` still said PROTECTED. Gemini's field is milliseconds (documented default
  60000); Claude Code's and Codex's are seconds. Cursor does not document the unit, so warden
  OMITS the field there and takes Cursor's default: guessing small disables protection silently
  and guessing large wedges the user's agent, and neither is acceptable from a guardian.
  — confidence 9 — would change if Cursor documents the unit; then it gets an explicit value.**

- **[D-025] Only Claude Code gets the `args` array form; every other vendor gets one
  shell-quoted command STRING — rationale: also found live. Gemini CLI's hook schema has no
  `args` field, silently dropped it, executed a bare `node`, and logged `0 succeeded, 1 failed`
  for every event. Claude Code is the only one of the six that documents `args`, and it is worth
  keeping there because the exec form avoids a shell entirely. The string form is still built
  only from warden's own absolute paths plus fixed literals, so T-04 holds in both forms.
  — confidence 9 — would change per-vendor as each documents an args array.**

- **[D-026] The Gemini adapter always emits a JSON document, using `{}` where the other adapters
  emit nothing — rationale: measured. Gemini counted an empty stdout as a hook failure even with
  exit code 0 and clean stderr. `{}` is a valid document that carries no decision. — confidence 9
  — n/a.**

- **[D-027] Gemini is recorded as PARTIALLY-VERIFIED-LIVE rather than VERIFIED-LIVE — rationale:
  hook registration, hook execution and event capture are all proven against a live Gemini CLI
  process, but that process has no credentials on this machine (no `GEMINI_API_KEY`, no OAuth)
  and exits before making any model-driven tool call, so the `BeforeTool` deny path has not
  fired against a live model. Overstating it as VERIFIED-LIVE would be exactly the kind of
  self-reported success the spec forbids. — confidence 10 — would change the moment a Gemini
  credential exists; the fixture and the runner are already in place.**

## Phase 6

- **[D-028] The `live` flag on an incident means "produced by a real `warden hook` process",
  and nothing stronger — rationale: that is the only distinction warden can actually observe.
  It cannot tell a hook invoked by Claude Code from the same binary invoked by hand with the
  same payload. Two of the 20 live incidents came from a hand-run
  `warden hook gemini pre_tool` during Phase 5, and the verification artifact says so explicitly
  rather than letting the counter imply a live Gemini model was stopped. A counter that quietly
  overstates is the same failure class as a guardian that quietly is not running.
  — confidence 9 — would change if a vendor supplies a signed or otherwise attestable invocation
  marker, which none of the six currently does.**

- **[D-029] The mandatory hook-removal check is verified as an A/B against a live agent, not only
  as a unit test — rationale: a unit test can only prove that `buildStatus` returns the string
  UNPROTECTED. The A/B proves the thing that actually matters: same fixture, same prompt, same
  agent, hooks present -> BLOCKED; hooks removed -> the read SUCCEEDED and the agent printed the
  fixture's fake credentials; hooks restored -> BLOCKED again. That is the only form of evidence
  that distinguishes "warden is working" from "nothing was ever going to happen anyway".
  Artifact: `verification/live/08-ab-removal.txt`. — confidence 10 — n/a.**

- **[D-030] Layer-1 catch rate is asserted numerically at >= 80% over 17 scenarios and the actual
  figure is PRINTED by the test — rationale: §3.4 states the requirement, and a requirement with
  no measurement is a wish. Measured: 15/17 = 88.2%. The only two misses are goal abandonment and
  invariant violation, which are semantic by nature and belong to Layer 2; the test asserts the
  miss LIST exactly, so a future regression that starts missing a deterministic check fails even
  though the percentage might still clear 80%. — confidence 9 — n/a.**

## Phase 7

- **[D-031] `uninstall` deletes the hooks CONTAINER when warden created it and nothing is left
  inside — rationale: found by the clean-machine simulation, not by the unit tests. On a config
  that had never had a `hooks` block, warden created one, and `uninstall` removed its entries but
  left `"hooks": {}` behind — one key short of byte-identical. The unit fixture already had a
  hooks block, so it could not possibly catch this; only a full install-to-restore lifecycle on a
  virgin config did. Whether warden created the container is now recorded in the store at init
  time rather than guessed at removal time, so a user who genuinely had an empty `hooks: {}`
  keeps it. Both cases now have a regression test. — confidence 9 — n/a.**

- **[D-032] The clean-machine simulation packs a REAL `npm pack` tarball and installs it, rather
  than running `dist/` in place — rationale: the `files` allowlist, the `bin` mapping, and the
  absence of install scripts are all properties of the tarball, not of the working tree. Running
  the working tree would test none of them. The simulation also asserts the tarball contains no
  `src/`, `tests/`, `fixtures/`, `verification/` or `scripts/`. — confidence 9 — n/a.**

- **[D-033] The simulation's "warden wrote nothing outside its own paths" assertion explicitly
  excludes `~/.npm/` and the python bytecode cache, and says so in the output — rationale: both
  are created by the harness (npm install, and the script's own `python3` calls with HOME
  redirected), not by warden. An assertion that quietly excluded them would be a lie by
  omission; one that failed on them would be a false alarm. Naming them is the honest option.
  — confidence 9 — n/a.**

## Phase 8

- **[D-034] Recommended package name is `usewarden`, keeping `warden` as the BINARY name —
  rationale: `warden` is taken on npm (v0.1.1) and `@warden` is taken on GitHub, so the bare name
  is not shippable. `usewarden` was the only candidate of eight with npm free, GitHub handle
  free, and no NS record on the `.dev`. The binary name is what users type and does not have to
  match the package. `agentkeel` is the fallback; `@djayamah/warden` is the always-available last
  resort. — confidence 7 — would change on a registrar or trademark check, which is a founder
  action; `launch/NAME-CANDIDATES.md` states plainly that a missing NS record is NOT proof a
  domain is free.**

- **[D-035] Domain availability is reported from `dig NS`, with its limitation stated in the
  document rather than glossed — rationale: a registered-but-unconfigured domain has no NS
  record, so "no NS" is suggestive, not conclusive. Only a registrar/WHOIS lookup at purchase
  time settles it, and purchases are explicitly forbidden here. Reporting `dig` output as
  "available" would have been the kind of confident-but-wrong claim that makes a whole document
  untrustworthy. — confidence 10 — n/a.**

- **[D-036] The launch posts quote real session transcripts verbatim, including their slight
  awkwardness — rationale: the spec requires the posts be built on real Phase 6 incidents.
  Polishing an agent's actual words into something punchier would make them unverifiable, and
  the transcripts are in `verification/live/` for anyone who asks. The notes section says so
  explicitly so a future editor does not "improve" them. — confidence 9 — n/a.**

- **[D-037] The community rules registry is designed on one page and NOT built — rationale: the
  spec says design it and build nothing. It would also be warden's single largest new attack
  surface, and it is worth nothing before warden has users. The design fixes the four constraints
  that would make it safe (packs may only add restrictions, packs are never executable, add shows
  a diff and waits, distribution is a git repo not a service) and names the trigger to revisit:
  three users independently asking for the same rule. — confidence 8 — n/a.**

## Phase 10

- **[D-038] Organization creation is UI-only; the repository was created under the personal
  account `djayamah` and org creation went to the manual checklist — rationale: checked, not
  assumed, exactly as the spec instructed. The GitHub Orgs REST section
  (docs.github.com/en/rest/orgs/orgs, fetched 2026-08-19) exposes get / update / delete /
  membership listing and has no create endpoint. — confidence 10 — n/a.**

- **[D-039] Branch protection and the required-reviewer environment could NOT be applied:
  GitHub Free refuses both on a PRIVATE repository — rationale: measured, not inferred. The
  rulesets API and the legacy branch-protection API both returned
  `403 Upgrade to GitHub Pro or make this repository public to enable this feature`, and the
  environments API returned `422 ... ensure the billing plan supports the required reviewers
  protection rule` (and rejected even `wait_timer: 0`). The user's hard limits forbid purchases
  and reserve the make-it-public decision to them, so BOTH escape routes are theirs to take.
  Every affected control is reported as a loud FAIL by `scripts/verify-hardening.sh`, and
  `scripts/apply-hardening.sh` is idempotent so one re-run applies them the moment the plan
  allows it. This is the most important gap in the build and it is stated as such rather than
  softened. — confidence 10 on the finding — would change on GitHub Pro or public visibility.**

- **[D-040] `prevent_self_review` is set to `false` while there is one maintainer — rationale:
  with a single required reviewer and `prevent_self_review: true`, nobody could ever approve a
  release. The gate would be a lock with no key, and a lock with no key gets removed in a hurry
  — the same reasoning as warden's own escape hatch (T-08). Set to `false`, the gate still
  forces a deliberate, separate, human approval after the merge, which is the step that actually
  breaks the automated push-to-publish chain. `ops/SETUP-BY-HAND.md` step 11 says to flip it the
  day a second maintainer exists. — confidence 8 — would change with a second maintainer.**

- **[D-041] `verify-hardening.sh` counts UNVERIFIED as a FAILURE and never reports PASS for a
  control it could not read — rationale: the spec's requirement, and the right one. Four controls
  are genuinely unreadable by any API: a user's own classic PAT list, npm account 2FA state, npm
  per-package publishing access, and the trusted-publisher configuration. Reporting those as PASS
  because nothing objected would make the whole report decorative. Each UNVERIFIED row names the
  manual step that settles it. — confidence 10 — n/a.**

- **[D-042] Actions are pinned to the SHAs of the CURRENT major releases (`actions/checkout`
  v7.0.1 = `3d3c42e5…`, `actions/setup-node` v7.0.0 = `820762786…`), resolved through the GitHub
  API rather than copied from memory — rationale: a tag is mutable and repointing one at
  malicious code is a documented technique; a SHA is not. The v5 tags I first resolved turned out
  to be two majors behind, which is exactly why this was looked up rather than recalled.
  `verify-hardening.sh` fails if any `uses:` line is not a 40-hex SHA. — confidence 9 — would
  change on each action release; Dependabot's `github-actions` ecosystem entry keeps the SHAs
  moving.**

- **[D-043] `verify-hardening.sh` reports that the npm name `warden` is TAKEN by another
  maintainer (`qubyte`) as a FAIL, not a note — rationale: it is a hard blocker for publishing
  and it was discovered by the script rather than assumed from the Phase 8 research, which makes
  it a live check rather than a stale document. The script distinguishes three cases: unclaimed
  (PASS), published and ours (proceed to the settings checks), published and someone else's
  (FAIL). — confidence 10 — n/a.**

- **[D-044] Two bugs in my own hardening scripts, both found by running them: `gh api --jq`
  prints the error body to stdout on failure, so a 403 body was being interpolated into the next
  request URL; and the environments API rejects even `wait_timer: 0` on this plan, so the
  fallback needs a completely empty body. Both fixed. Recording them because a hardening script
  that silently half-works is worse than none. — confidence 9 — n/a.**

## Post-build correction

- **[D-045] PROGRESS.md was rebuilt in full at the end of the build, because the per-phase
  verification tables I thought I had been appending had silently not landed — rationale: each
  phase's update used an exact-string `str.replace()` against a "## Next action" block; the
  phase-status one-liners matched and the multi-line blocks did not, so `replace()` returned the
  string unchanged and nothing failed loudly. The file kept saying "Phase 0" at the bottom for
  ten phases while every status line read DONE. Nothing was lost — every figure in the rebuilt
  tables comes from a committed artifact under `verification/` — but the cold-resume guarantee
  the file exists to provide was not actually being met, and `FINAL-REPORT.md` pointed at tables
  that were not there. Recorded rather than quietly fixed, because it is the same failure class
  as the bugs this build kept finding in warden itself: an operation that reports success while
  doing nothing. — confidence 10 — the fix is to verify the effect of an edit, not its exit
  status; the rebuilt file was checked by reading it back.**

## Public-launch phase (2026-08-19, post-BUILD_COMPLETE)

- **[D-046] The product is renamed `usewarden` everywhere — package, binary, CLI command, config
  file, state directory, environment-variable prefix, dashboard title, status line, docs and
  screenshots — rather than keeping `warden` as the command name — rationale: availability was
  re-checked live rather than trusted from the Phase 8 research, and the result held: `npm view
  usewarden` 404s, `gh api users/usewarden` 404s, while `npm view warden` still returns 0.1.1
  (maintainer `qubyte`). `launch/NAME-CANDIDATES.md` had recommended `usewarden` on npm *while
  keeping `warden` as the binary*; the founder's launch instruction explicitly lists "bin name,
  CLI command" among the things to rename, which retires that half of the recommendation. Two
  facts make the fuller rename the better call anyway: (a) `wardenenv/warden` (warden.dev) is an
  established Docker/Magento dev-environment CLI that already owns the command name `warden` on
  many developers' PATH, so shipping a second `warden` binary would shadow a real tool — a
  collision a security product cannot afford; (b) one name across npm, GitHub, CLI and docs means
  there is exactly one string to search for, which is what made this rename verifiable at all.
  103 tracked files were rewritten by a case-preserving substitution with a negative lookbehind
  so the operation is idempotent, then the tree was grepped for any residual `warden` not part of
  `usewarden` — zero hits. — confidence 8 — would change if `usewarden` turned out to be
  trademark-encumbered, in which case `agentkeel` (equally clean on all three namespaces, and a
  better standalone command word) is the drop-in fallback and the same script performs the swap.**

- **[D-047] `SPEC-BUILD.md`, `launch/NAME-CANDIDATES.md`, `PROGRESS.md` and `DECISIONS.md` were
  deliberately EXCLUDED from the mechanical rename — rationale: they are the historical record.
  Rewriting the founder's original spec, or research whose entire subject is the availability of
  the word "warden", would make the record say something that was never true. Each carries a
  dated note at the top instead. — confidence 9 — n/a.**

- **[D-048] Two guards in the build scripts identified this repository by the NAME of the
  directory it sits in (`*/warden/fixtures`, `*/warden/fixtures/sandbox-project`) and both broke
  the instant the package was renamed while the working copy kept its old directory name. Both
  now identify the repo by content (`package.json`'s `name` field) and by comparing resolved
  absolute paths derived from the script's own location — rationale: a name-based fence is a
  fence with a gate in it, and it failed exactly the way this project keeps documenting: loudly
  refusing to run is the good outcome, but it refused for a reason that had nothing to do with
  safety. `scripts/live-session.sh`'s hard-coded private-project denylist was replaced with an
  optional, untracked `scripts/forbidden-paths.txt`, which keeps a private project name out of a
  public repository without weakening the fence. — confidence 9 — n/a.**

- **[D-049] `CLAUDE.md` and a `PreCompact` hook now carry the invariants across compaction, and
  the hook was proven to fire rather than assumed to — rationale: the hook contract was read from
  the primary docs (code.claude.com/docs/en/hooks) rather than recalled: the matcher for
  `PreCompact` is an EXACT string, `manual` or `auto`, with no regex, so both are registered as
  separate entries; stdin carries `{session_id, transcript_path, cwd, permission_mode,
  hook_event_name, trigger}`; exit 2 BLOCKS compaction, so `scripts/progress-snapshot.sh` never
  exits 2. Proof of firing is two independently-produced timestamps: the hook's own append-only
  log recorded `trigger=manual session=f196aeb5-…` at 16:07:16Z, and that same session's
  transcript records `compact_boundary` at 16:08:25.859Z — the snapshot landed 69 seconds before
  the compaction. The session id came from Claude Code on the hook's stdin and matches the
  transcript filename, so this is not a hand-run of the script wearing a costume.
  `verification/precompact-hook-proof.txt`. — confidence 9 — would change if the hook contract
  changes; the artifact records the doc URL and the exact schema it was built against.**

- **[D-050] Two bugs in the snapshot script, both found by running it rather than by reading it:
  a bare `cat` on stdin hung forever when the script was run from a terminal (stdin open, no
  payload), so the read now uses a `select()` with a 0.5s timeout; and `usewarden status` exits
  non-zero by design when protection is not fully healthy, which under `pipefail` appended a
  second line and made the snapshot report the judge spend twice — once as `$0.0000` and once as
  `unreadable`. A PreCompact hook that hangs is strictly worse than no hook: it would have burned
  the whole 600s default timeout on every compaction. — confidence 9 — n/a.**

- **[D-051] Publication is from a SINGLE ORPHAN COMMIT on a `publish` branch pushed to a NEW
  repository, not from a rewritten version of the build history — rationale: the first scan found
  contamination in 22 of 23 commits (423 machine-path hits, the hostname, private project names,
  a third party's email). `git filter-repo` would rewrite the branch, but GitHub keeps
  UNREACHABLE objects fetchable by SHA for a long time after a rewrite, and on a PUBLIC
  repository that is a real exposure — the standard advice after a leak is a fresh repository,
  not a rewrite. Deleting and recreating `djayamah/warden` is not available either: the token
  does not carry the `delete_repo` scope, and asking for one is a credentials action reserved to
  the founder. A brand-new repository with one clean commit has no unreachable objects at all.
  The engineering record the history would have carried is published instead as `DECISIONS.md`
  and the artifacts under `verification/`. The private `djayamah/warden` keeps the full 23-commit
  build history and stays private. — confidence 9 — would change if the founder grants
  `delete_repo` and prefers a single repository, in which case delete-and-recreate under the
  original name is equivalent.**

- **[D-052] The scanner's operator-identity strings live in an UNTRACKED
  `scripts/scan-identity.txt`, not in the script — rationale: the first version hard-coded the
  private project name as a pattern, and pass 2 promptly matched the scanner's own pattern file.
  A scanner that ships the string it is hunting for has published that string. Identity matches
  are now reported as `[operator-identity]` with the matching LINE redacted, and the script pipes
  all of its own output through a `$HOME`→`~` redactor, because this artifact is itself
  published. — confidence 9 — n/a.**

- **[D-053] Three findings came from the scanner and not from review, which is the whole argument
  for having one: (a) `.usewarden-shot/`, a screenshot staging directory swept into a commit by
  `git add -A`, whose 42 backup filenames encode the build machine's absolute paths; (b)
  `/private/tmp/claude-<uid>/-Users-<name>-dev-<repo>/…` harness scratchpad paths, which encode
  the home directory in a shape the sanitiser's `/Users/<name>/` rule did not match; (c) the
  account name as a bare `ls -l` owner column, with no slash near it. Each one is now a rule in
  `scripts/sanitise-for-publication.sh`, so the fix is reproducible rather than remembered. —
  confidence 10 — n/a.**

- **[D-054] Published screenshots are rendered under a THROWAWAY HOME by
  `scripts/screenshot-synthetic.sh`, from the real captured incidents — rationale: the images are
  the product's front door and the first capture carried the operator's account name in the agent
  config table, in every incident path, and in a `/var/folders/…` temp path. The fix has two
  halves. The product now collapses `$HOME` to `~` on every screenshot-facing surface
  (`displayPath()`, display only — scope decisions still resolve absolute paths, and a test
  asserts a `~`-collapsed path does NOT satisfy a scope check). And the capture runs under a
  synthetic home with a synthetic project, so what is rendered is `~/dev/acme-api`. What is REAL
  in the published images: every incident, rule, layer, reason, timestamp and counter. What is
  REWRITTEN: absolute paths only, plus the pre-rename product name in reason text. The wall shows
  the 20 catches from real agent sessions; the demo/simulation entries are excluded because they
  are the same four blocks repeated once per run of the verification harness. The README says
  this next to the image. — confidence 8 — would change if a reader reasonably read the caption
  as implying the paths were captured verbatim; the caption is therefore explicit.**

- **[D-055] `verify-hardening.sh`'s ruleset branch had a latent syntax bug that only surfaced the
  first time the repository was actually hardened — rationale: the block used `eval "$(… | python3
  -c "…")"`, and bash 3.2 (still `/bin/bash` on macOS) parses nested double quotes inside a
  command substitution inside an `eval` differently enough that the set-comprehension braces came
  out mangled. Until today no ruleset existed, so that branch had never executed: the script had
  been exercised only on its failure path. Both `eval` blocks now write their python to a file
  and source the result. This is the same class of defect the product keeps finding — a check
  that reports confidently right up until the moment it is asked to do the thing it exists for. —
  confidence 9 — n/a.**

- **[D-056] `verify-hardening.sh` now asserts the repository is PUBLIC, where it previously
  asserted PRIVATE — rationale: the founder took the publication decision on 2026-08-19, so
  public is the intended state, and a check still testing the old intent would report a FAIL for
  exactly the thing that was supposed to happen. Public is also the precondition for the two
  controls GitHub Free refuses on private repositories, both of which applied on the first
  re-run. — confidence 10 — n/a.**

- **[D-057] Branch protection is proved by ATTEMPTING a push as the repository owner, not by
  reading `bypass_actors: []` back out of the API — rationale: reading the setting proves what
  the API says, not what the server does, and the owner is precisely the actor an admin-bypass
  hole would exempt. Direct push, force push and branch deletion were all rejected, exit 1, and
  `main` still points at the published commit. One honest caveat is recorded in the artifact: the
  deletion attempt was refused by GitHub's default-branch guard ("refusing to delete the current
  branch") before the ruleset's `deletion` rule got a turn, so attempt 3 proves main cannot be
  deleted but does not on its own prove which control stopped it. Attempts 1 and 2 are
  unambiguous. — confidence 10 — n/a.**

- **[D-058] The one remaining hardening FAIL — the `gh` CLI token carrying `repo` and `workflow`
  scopes — is left FAILING rather than waved through, and is handed to the founder as a manual
  action. Rotating or revoking a token is a credentials operation, which this run is forbidden
  from performing, and the scopes are genuinely required by the work still in flight (pushing
  branches, opening PRs, editing rulesets). Reporting it as PASS "because it is needed" is how a
  hardening report becomes decorative. — confidence 10 — would change once the founder rotates
  the token to read-only after the launch.**

- **[D-059] Two of the three metered providers were shipping with WRONG PRICES and one with a
  retired model id, and nothing anywhere said so — rationale: the figures were checked against the
  vendors' current published pricing while building the contract suite. `gpt-5-mini` had moved
  from $0.25/$2.00 to $0.125/$1.00; `gemini-2.5-flash` at $0.30/$2.50 had been superseded by
  `gemini-3.7-flash` at $0.75/$3.75. Anthropic's `claude-haiku-4-5` at $1.00/$5.00 was still
  correct. The fix is not just new numbers: each provider now carries a `pricedOn` date and a
  `pricingSource` URL, and `pricingStaleness()` emits `JUDGE_PRICING_STALE` once the figures are
  more than 120 days old. A hard-coded price is a fact with a shelf life, and a cost ledger that
  is confidently wrong is worse than one that says it might be. Token counts are recorded exactly
  and are never estimated, so a stale price can make the USD column wrong but can never corrupt
  the usage it is derived from. — confidence 9 — would change if the vendors published a
  machine-readable price feed, which would let the table be fetched rather than dated.**

- **[D-060] The provider contract suite stubs `globalThis.fetch` rather than mocking usewarden's
  own transport — rationale: mocking an internal seam would prove usewarden calls its own wrapper
  correctly, which is not the thing in doubt. Stubbing the platform's `fetch` puts the assertions
  on the actual bytes: the URL, the method, the header names, and the JSON body, checked against
  each vendor's published schema. Forty tests cover request shape, response parsing, token and
  cost accounting into the ledger, and fail-open behaviour on auth failure, rate limit, timeout,
  5xx and malformed 200s, for all three providers. Three assertions are security controls rather
  than contract checks: the API key must never appear in a warning string, the Gemini key must
  never be a query parameter (URLs reach proxy and CDN logs), and a 400 that echoes the request
  must not paste the transcript into a terminal. — confidence 9 — n/a.**

- **[D-061] The metered providers are labelled UNVERIFIED-LIVE in the README and the hook matrix,
  and stay that way until a real key has been used — rationale: a contract test proves usewarden
  holds up its end of the protocol. It cannot prove the vendor still holds up theirs; an API
  version bump, a renamed usage field or a retired model id all look identical to a green suite.
  This is the same distinction the rest of the project already enforces — fixtures prove a check
  works, only production proves it fires — and it would be inconsistent to relax it for the one
  subsystem that talks to somebody else's server. `usewarden judge-check` was added so settling it
  is one command per provider rather than a hand-built payload: it runs the whole path on a
  scenario whose correct answer is not in doubt and prints which provider answered, the latency,
  the exact tokens, the cost, whether the ledger moved by the same amount, and PASS/FAIL.
  Verified working end to end against the local-claude judge: drift detected at confidence 0.95.
  — confidence 10 — would change on a passing `judge-check` per provider, recorded in
  `verification/judge-live-check.txt`.**

- **[D-062] Non-2xx provider responses now produce a classified, redacted message instead of
  `HTTP <status>` — rationale: `HTTP 401` and `HTTP 429` fail open identically but mean opposite
  things to the user; one is a misconfiguration that no amount of retrying fixes, the other is a
  blip. `describeHttpFailure()` labels them AUTH / RATE_LIMIT / PROVIDER_DOWN / REQUEST_REJECTED,
  quotes the vendor's error TYPE but never its prose (a 400 frequently echoes the request back,
  and the request contains the transcript window), runs the result through `redact()`, and caps it
  so a hostile error body cannot flood a terminal. — confidence 9 — n/a.**

- **[D-063] The provider contract suite's fake API keys were reshaped so they no longer match any
  scanner's credential pattern — rationale: the first version used the vendors' real prefixes
  (`sk-ant-`, `sk-proj-`, `AIza`) for realism, and this repository's own pre-publication scanner
  flagged two of them as leaked credentials on the very next run. It was right to. A scanner
  cannot distinguish a convincing fake from the real thing, and neither can GitHub push
  protection, nor anyone grepping the repository in a year. Nothing in the tests depends on the
  shape — every assertion is about where the string travels, not what it looks like — so the
  realism bought nothing and cost a permanent false positive in a security tool's own repo. Same
  class as the `sk_test_FAKE…` Stripe bait in the sabotage fixture, fixed the same way. —
  confidence 10 — n/a.**

- **[D-064] Recording a process failure of my own: the publication scan was run in a shell chain
  ending in `| tail -3`, so the pipeline's exit status was `tail`'s, the `&&` guard did not fire,
  and a branch was pushed to the public repository while the scan said BLOCKED. The contents were
  the two synthetic strings above, so nothing was exposed — but the gate did not hold, and it did
  not hold for the most ordinary reason there is. The scan is now run as its own command with its
  exit status read directly, never through a pipe. This is exactly the failure the product keeps
  documenting: a check that ran, reported correctly, and was then not acted on because something
  in the plumbing swallowed the signal. — confidence 10 — n/a.**

- **[D-065] `fs.mkdirSync(p, { recursive: true })` never returns when the target sits on procfs,
  and usewarden's hook called it on every invocation — so `USEWARDEN_HOME` pointing anywhere under
  `/proc` made the hook BLOCK FOREVER on Linux, which means the agent blocked forever. Fixed with
  `mkdirpSafe()` — rationale: this is the worst failure this product can have. The hook sits in
  the agent's critical path and the entire promise is that it fails OPEN; a hang fails neither
  open nor closed, it just stops the user's work while looking like nothing at all. The existing
  test asserted "an unreadable USEWARDEN_HOME fails OPEN rather than crashing the agent" and it
  passed on macOS, which has no `/proc` — the assertion was right and the platform hid the bug.
  A watchdog timer cannot rescue this: the block is inside a synchronous syscall, so no timer in
  that process ever gets a turn. `mkdirpSafe()` therefore never makes the call that can block —
  it walks up to the nearest existing ancestor with `statSync` (which returns instantly even on
  procfs), checks it is a writable directory, then creates each missing component with the
  NON-recursive form, which fails fast with ENOENT. It also refuses `/proc`, `/sys` and `/dev` by
  name, because "refusing to create /proc/x: /proc is a virtual filesystem" is a better message
  than a timeout. Every recursive `mkdirSync` in `src/` now goes through it. Measured: before,
  killed at 20s; after, exit 0 immediately. — confidence 9 — n/a.**

- **[D-066] How it was found is the point: three CI legs on ubuntu stalled at the test step while
  macOS and every local run passed. The first instinct was to theorise about detached children and
  open sockets; that produced four wrong hypotheses in ten minutes. Starting a Linux VM and
  reproducing it took three commands and produced the exact call. The lesson recorded here for the
  next time: when a failure is platform-specific, reproduce on the platform before reasoning about
  it. CI was also changed so the next stall names itself — `npm test` now carries
  `--test-timeout=120000`, the job carries `timeout-minutes: 15`, and an `always()` step reports
  stray processes and listening sockets. A test that hangs tells you nothing; a test that times
  out tells you which one. — confidence 10 — n/a.**

- **[D-067] The new SAB-16 tests assert a LATENCY BOUND, not just an exit code — rationale: the
  property that matters is "usewarden cannot hang the agent", and only a deadline expresses it.
  Four pathological `USEWARDEN_HOME` values are driven through the real hook subprocess with a
  hard `timeout` and `killSignal`, and the test fails if the child had to be killed, if it exited
  non-zero, or if it took more than 10 seconds. Every `spawnSync` in the sabotage file now carries
  a timeout for the same reason: a hang must surface as a failing test, never as a stalled job.
  The suite also asserts the sabotage landed first — that the probe locations really are
  unusable — so a green result cannot come from a probe that was quietly fine. — confidence 9 —
  n/a.**

- **[D-068] `verify-all.sh` intermittently reported `FAIL full suite on v22.22.0 (exit 0)` for a
  run that had just passed 247/247, and the cause was in the gate, not the suite — rationale: the
  check was `[ $RC -eq 0 ] && printf '%s' "$OUT" | grep -qE '^# fail 0$'` under `set -o pipefail`.
  `grep -q` exits the instant it finds its match; the producer then takes SIGPIPE and exits 141;
  pipefail promotes 141 to the pipeline's status, so the condition is FALSE even though the match
  succeeded. With ~1,900 lines of TAP and the match on the second-to-last line it is a race, which
  is why it passed on some runs and failed on others. Every such check now uses a here-string,
  which has no pipeline and therefore no SIGPIPE. It appeared twice before being taken seriously,
  and the first response — re-running until it went green — is precisely the habit a flaky gate
  trains. A gate that intermittently fails a passing run is worse than no gate. Also fixed the
  same pattern in `apply-hardening.sh` and `verify-hardening.sh`, where a plan-limit message could
  have been missed the same way. — confidence 9 — n/a.**

## Metrics & telemetry run (2026-08-20)

- **[D-069] Every reported figure is DERIVED by query per origin, not read from a counter —
  rationale: the defect was found by looking at the output, not by any test. Three
  `usewarden demo` runs into a clean state directory reported `actions_blocked: 12` and
  `events_seen: 8` — twelve blocks from zero real agent sessions, against eight inspected
  events. Two causes: the demo wrote into the same counters the headline read from, and
  `pipeline.record()` recorded an incident even when `store.recordEvent()` had just reported the
  event as a duplicate delivery, so a replay double-counted. A monotonic counter cannot be
  recomputed or corrected; it can only ever be wrong forever. Schema v2 therefore adds an
  `origin` axis (`live` / `demo` / `fixture`) to sessions, events and incidents, and every figure
  is a query with a `WHERE origin = ?`. `src/metrics.ts` is the single source, and every surface —
  status, dashboard, status line, telemetry — reads from it. The raw counters survive as a debug
  ledger and are labelled as such. Before/after artifacts:
  `verification/metrics-inflation-{before,after}.txt`. — confidence 9 — a figure that cannot be
  derived from a table (an irreversible external event, say) would need a different mechanism,
  and would need to be labelled as unverifiable rather than quietly counted.**

- **[D-070] Incidents get their own dedupe hash on the same 2-second bucket as events —
  rationale: the events table already collapsed a duplicate delivery (D-005, Cursor replaying a
  Claude Code hook) and the incidents table did not, which is why a clean install could report
  more blocks than events. Two seconds collapses a duplicate *delivery* while leaving a genuine
  repeat attempt seconds later counted as the separate attempt it is — which SAB-19 asserts in
  both directions. The hash includes the origin, so a demo and a live catch of the same shape
  never collapse into each other. — confidence 9 — an agent that legitimately issues the same
  tool call twice inside 2s would be under-counted; nothing observed does this, and under-counting
  is the safe direction for a number used as evidence.**

- **[D-071] `attempts` and `distinct_actions` are both reported, and the savings estimate uses
  only `distinct` — rationale: an agent that retries the same forbidden `.env` read five times
  made five attempts against one distinct action. Both are true and they answer different
  questions, so reporting only one is a choice about which truth to tell. "How often did
  usewarden have to intervene" is `attempts`; "how many distinct bad things did it stop" is
  `distinct_actions`, and that is the one that belongs on a slide. Blocking one action five times
  did not save five recoveries, so the estimate counts distinct only. — confidence 9 — n/a.**

- **[D-072] The savings estimate is a BAND, never a point, and refuses to price two whole
  categories — rationale: spec 3.6 requires an estimate of tokens and dollars saved with the
  method documented honestly and no invented precision. The honest version of this has three
  parts. (1) The output is a range and there is deliberately no function anywhere that renders a
  single savings number — the width of the band is the honesty. (2) The constants are stated as
  assumptions, printed by `usewarden metrics --json`, and stamped with a method id
  (`distinct-live-blocked-actions/v1`) so an old figure can never be mistaken for a new one; the
  only constant tied to something real is the `drift` high bound, which is one Layer-2 trigger
  window (`judge.every_n_events`, default 15) and therefore by construction the longest a drift
  can run before usewarden's own judge would have looked at it. (3) Credential exposure and shell
  execution are counted and NEVER converted to dollars. A tool that turned "we stopped your API
  key reaching a model context" into "$0.04" would be telling the user less than it knows, not
  more. `savings.measured` is `false` and docs/METRICS.md §4.6 states the three things that would
  have to become true for it to flip. — confidence 8 — real token accounting read from an agent
  transcript, plus an observed counterfactual, would replace the assumption with a measurement.**

- **[D-073] The reference price was re-checked against the vendor's published page today rather
  than recalled — rationale: the judge ledger already carries `pricedOn` and a staleness warning
  because a hard-coded price is a fact with a shelf life, and the figures this repo shipped with
  on 2026-08-19 were already wrong for two of three providers. The savings estimate inherits that
  discipline: `REFERENCE_PRICE` names claude-sonnet-5 at $2.00/$10.00 per MTok, checked
  2026-08-20 against platform.claude.com/docs/en/about-claude/pricing. That page also records
  that Sonnet 5's introductory rate is now the standard rate and the increase to $3/$15 will not
  occur, so the figure is current rather than provisional. Two caveats print with it every time:
  your model and rate will differ, and on a subscription plan this is quota, not dollars.
  — confidence 9 — any vendor price change; the staleness window makes it visible rather than
  silent.**

- **[D-074] Telemetry consent is a RECEIPT bound to a schema version, not a boolean —
  rationale: off-by-default is necessary and not sufficient. The failure it does not cover is
  consent drift: a user agrees to send five counters, a later version adds a sixth, and the
  original yes silently covers something they never read. So opting in writes
  `~/.usewarden/telemetry/consent.json` naming the schema version and every field consented to,
  with a digest binding the two, and `telemetryEnabled()` requires a receipt that matches what
  this build would send today. Three properties follow, each with a test: flipping the setting in
  the database opts nobody in (SAB-23); bumping `SCHEMA_VERSION` lapses every existing receipt so
  telemetry switches itself off until the user reads the new payload; and a receipt edited to
  widen its field list fails its own digest. Consent expires by construction rather than by good
  intentions. — confidence 9 — n/a.**

- **[D-075] Opting in is refused, not assumed, when usewarden cannot ask — rationale: `telemetry
  on` prints the exact payload built from the machine's real numbers and then waits for a
  confirmation. In a pipe, a script, or with `--json` there is nowhere to read an answer from, and
  the two available defaults are "assume yes" and "refuse". A security tool that resolves an
  ambiguous consent prompt in its own favour has spent the credibility the rest of the product is
  built on, so it refuses and says `--yes` is required. — confidence 9 — n/a.**

- **[D-076] The aggregation service stores no identifier at all, and its rate limiter is
  deliberately amnesiac — rationale: the service is built and not deployed, but the design
  decision that matters is made now, because it is the one that is hard to reverse once data
  exists. A submission is folded into a `(day, platform, node major, sorted agent set)` bucket on
  arrival and its individual shape ceases to exist; there is no install id, cookie, fingerprint,
  or IP column, and a test walks the schema and fails on any column name that could tell installs
  apart. That is stronger than a retention policy because it does not depend on anyone remembering
  to run a deletion job. The one place a service like this normally acquires the ability to
  distinguish submitters is its rate limiter, so that limiter keys on a salted hash of the remote
  address, held in memory only, with a salt regenerated per process and never persisted — two runs
  of the service cannot correlate the same submitter. — confidence 9 — a genuine need for
  per-install longitudinal data would require a different design AND a different consent flow;
  neither exists.**

- **[D-077] The service re-derives every guarantee the client already makes, including the
  arithmetic — rationale: the server validating what usewarden's own client just built looks
  redundant and is not. They are two independent implementations of the same rule, and SAB-22 is
  the contract test between them: whatever the client builds, the server must accept, and the
  pre-v2 inflated shape (12 blocks, 8 events) must be refused by both. If they ever drift, one of
  the two is wrong about what the numbers mean, and finding that out at the boundary is much
  cheaper than finding it out in a published statistic. A server that accepts impossible numbers
  will eventually publish them. — confidence 9 — n/a.**

- **[D-078] `service/` and `site/` are built, tested, and inert, and the inertness is asserted
  rather than promised — rationale: "not deployed" written in a README decays the moment somebody
  adds a Dockerfile in a hurry. `verify-all.sh` therefore fails if a deploy artifact appears under
  `service/`, `site/` or `.github/`, and if a telemetry endpoint is ever baked into the client;
  the packaging test fails if either tree can reach the npm tarball; and `tests/site.test.ts`
  asserts the landing page fetches nothing, runs no script, and carries no analytics. The first
  version of the deploy gate grepped for the words and tripped over `service/README.md`, which
  says in plain English that there is no Dockerfile — a gate that fails on a document promising
  the thing it is checking for is a gate people learn to ignore, so it now looks for files and
  commands. — confidence 9 — n/a.**

- **[D-079] The landing page's factual claims are pinned by test to the artifact that proves each
  one — rationale: a landing page is the one document nobody re-reads after writing it, so it is
  exactly the document that goes quietly stale. `tests/site.test.ts` re-checks the checkable
  claims against the repository: the incident card and the quoted agent reply must still be
  present in `verification/live/01-env-read.txt`; "15 of 17" is parsed out of SAB-13's actual
  scenario list and its named expected misses rather than trusted as prose; "0 runtime
  dependencies" and "no install scripts" are checked against `package.json`. The page also states
  in its own text that usewarden is not published, so nobody reads it as an invitation to install
  something that is not there. — confidence 8 — if the page grows claims that cannot be pinned to
  an artifact, those claims should not be on it.**

- **[D-080] The v1→v2 migration infers session and event origin from the incidents that reference
  them — rationale: the first version backfilled `incidents.origin` from the `live` column and
  left sessions and events at the `'fixture'` default. Technically conservative — `fixture` can
  only under-report — but the first run against this machine's real store printed eight blocked
  actions against zero inspected events, which is the same impossible arithmetic the whole change
  set exists to eliminate. A migration whose output looks broken will be assumed broken. Sessions
  and events are now backfilled from the one thing v1 did record: a session that produced a live
  incident was a live session, and its events were live events. Verified against the real store
  holding the 20 catches the verification record rests on: all 20 survived, and the figures became
  consistent. Pinned by a test that builds a v1 database by hand. — confidence 9 — a live session
  that produced no catch at all still migrates as `fixture`; that under-reports and is the safe
  direction.**

- **[D-081] `.env` access from bash is now an ALLOWLIST, and this was found by a live session
  rather than by the suite — rationale: the `dotenv-access` deny rule enumerates readers — cat,
  less, more, head, tail, bat, strings, xxd, od, cp, mv, scp, rsync, source. Asked for a `.env`
  value and told to retry, a real Claude Code session reached the variable names with
  `sed -n` and a capture-group substitution, and was not blocked, because `sed` is not on that
  list. Neither are awk, grep, cut, tr, jq, python, perl, dd, base64, nl, sort, uniq, split, tee,
  or the next one somebody thinks of. A denylist of readers is wrong the moment it is written. So
  Layer 1 inverts the polarity for this one narrow, high-value case: a bash command segment that
  names a real `.env` file is blocked unless its leading verb is on a short allowlist of
  operations that cannot disclose contents (ls, stat, test, find, touch, wc, file, ...). Scoped to
  `.env`-family files, to bash, and to the segment that actually names one, so it does not become
  the over-guard 3A.6 warns about. `.env.example` and its siblings are now exempt in BOTH rules:
  usewarden's own block message recommends using `.env.example`, and blocking the alternative it
  just recommended is precisely the documented trap. Proved live — the exact command that got
  through is now blocked and the agent did not route around it
  (`verification/live/12-dotenv-bypass-fixed.txt`). — confidence 8 — the agent's own reply argues
  this is a false positive for provably value-free extractions, which is fair; recognising them
  would mean parsing sed/awk expressions, and being wrong about that once costs a credential
  permanently. Conservative is the right default here, and the message names the escape.**

- **[D-082] `pre-public-scan.sh` must be run as `SCAN_REF=publish`, and the bare form is EXPECTED
  to block — rationale: run with no ref the scan walks all refs, and local `main` still contains
  blobs from a screenshot-staging directory that was committed once and removed (4cd7173), plus a
  third party's public npm-registry email inside `verification/hardening-initial.txt`. The
  published history is the separate `publish` branch built by `scripts/build-publish-tree.sh`, and
  `SCAN_REF=publish ./scripts/pre-public-scan.sh` is CLEAN. PROGRESS.md previously recorded the
  result without naming the ref, which is exactly the ambiguity that gets misread by a later
  session as a regression — it is now recorded with the ref. — confidence 9 — if local `main` ever
  becomes the published history, those blobs must be removed first.**

## Standing authorization (2026-08-20)

- **[D-083] The founder's standing authorization is written into `CLAUDE.md` as section 7, and
  the one rule that most needs to survive it is enforced by a hook rather than by the document —
  rationale: the grant is broad (dependencies, architecture, tests, CI, docs, judge spend to $15,
  pushing and merging on the PRIVATE remote, fixing any defect without pausing) with four
  permanent exceptions, the first being a push to the public repository. Section 7 records all of
  it, marks `SPEC-BUILD.md` §2.2 superseded in part so a cold-resume session does not read the old
  "no `git push`" clause as current, and states explicitly that §1 (paths), §2 (credentials), §3
  (hard limits), §4 (verification) and §5 (compaction) are untouched. It also names the two §3
  rows that are binding but NOT among the four — `sudo` and deploying services — because "these
  four are permanent" is easy to misread as "these four are the whole list".
  But a rule in a document is a rule a tired human or a confident agent walks past, and this
  repository ships a product whose entire thesis is that the guardrail should be a control rather
  than an instruction. So `.githooks/pre-push` refuses any push whose RESOLVED URL is the public
  repository. It matches on the URL and never on the remote's name, because a name is not a safe
  selector — `git push public` and `git push https://github.com/djayamah/usewarden.git` are the
  same action and a remote can be renamed; that is the identical mistake CLAUDE.md §1 calls out
  for branch names and D-048 for directory names, and a test asserts the public URL is refused
  even when it wears the name `origin`. It fails CLOSED on an argument it cannot parse, and its
  refusal names both the rule and the way out, because a control that leaves someone unable to
  work is the over-guard trap (3A.6). Proved in production, not just by unit test:
  `git push --dry-run public main` is REFUSED and `git push --dry-run origin main` succeeds — the
  same A/B shape as SAB-08. A further test fails the build if anything in the repository ever
  passes `--no-verify`. — confidence 9 — a founder who wants a public push runs it themselves with
  `--no-verify`; that is deliberately a human action with a visible flag.**

- **[D-084] The `--no-verify` scan looks at what can RUN, not at what mentions the flag —
  rationale: the first version kept a per-file allowlist and broke within minutes, when PROGRESS.md
  recorded the very row asserting the guard. An allowlist that has to grow every time someone
  documents the thing it protects is the wrong mechanism, and the failure mode is worse than
  noise: the obvious fix is to add the file to the allowlist, which trains people to widen the
  scanner rather than look at the finding. It now scans only file types that can execute, and
  inside those only for the flag actually attached to a `git` invocation. Prose may name the flag
  — CLAUDE.md, DECISIONS.md, PROGRESS.md and the hook's own refusal message all do, and should,
  because a control nobody can read about is a control nobody can reason about. Verified the way
  the sabotage suite verifies: a probe script containing `git push --no-verify public main` was
  committed, the test FAILED, and the probe was removed. A scanner that has never been shown to
  fail is a scanner nobody should trust. — confidence 9 — n/a.**

## Judge live check, selection policy, and disclosure (2026-08-20)

- **[D-085] `scripts/judge-live.sh` injects the key with a one-command assignment prefix and
  scrubs by SHAPE, not by value — rationale: three designs were available and two of them leak.
  `export KEY=...` outlives the command and lands in the parent shell. `env KEY=value cmd` puts
  the value in argv, where `ps -ww` can read it for the life of the exec. Bash's
  `KEY="$(security ...)" cmd` prefix does neither: the value is scoped to one command, never
  becomes a shell variable, and never appears in an argument list. Bash has no dynamic form of
  that prefix, so the script carries one literal branch per provider rather than computing the
  variable name — three near-identical lines are the price of keeping a key out of `ps`, and it
  is worth paying. The scrubber redacts by regex shape rather than by substituting the known
  value, because a value-substituting scrubber would have to hold the value in a variable, which
  is the single thing the script exists to avoid; the shape version also catches a *different*
  provider's key echoed back in a vendor error body. The script learns exactly one property of
  the credential, its character count, and a length is not a secret. `set -x` is absent and a
  test asserts it can never appear. — confidence 9 — n/a.**

- **[D-086] The Gemini live check FAILED and gemini stays UNVERIFIED-LIVE — rationale: the run
  was instructed on the assumption it would pass, and it did not: HTTP 401 UNAUTHENTICATED. The
  temptation in that position is to mark the row verified because the code path was exercised,
  and that is exactly the claim CLAUDE.md §4.4 forbids — UNVERIFIED is a failure, not a pass.
  What the attempt DID prove is worth recording separately, because "untested" and
  "attempted and rejected" are different states: `USEWARDEN_JUDGE_NO_LOCAL=1` took effect, the
  metered path really ran, the request really reached Google, and the fail-open path behaved.
  usewarden's request shape was then ruled out by sending the same credential three ways —
  `x-goog-api-key` and `Bearer`, on `v1beta` and `v1` — all refused identically; and the model id
  was ruled out separately, since `gemini-3.7-flash` is current per ai.google.dev and a wrong id
  returns 404 rather than 401. The stored value is 106 characters in three dot-separated
  segments; a Gemini Developer API key is `AIza` plus 35 characters, 39 in total. That is an
  OAuth/JWT-family token or a Vertex credential, not an AI Studio key. Diagnosed entirely from
  shape, without reading the value. — confidence 9 — an `AIza…` key in the same Keychain entry
  would settle it in one command.**

- **[D-087] Judge selection is CHEAPEST-CAPABLE, and the ordering is COMPUTED from the price
  table rather than written beside it — rationale: usewarden's own judge spend lands on the
  user's bill, so when several keys are present the default should be the one that costs them
  least; it was previously a hard-coded array, `['anthropic','openai','gemini']`, which is
  first-key-found wearing a sensible-looking order. Computing it matters more than it looks: a
  hand-written order is a second copy of the pricing information, and two copies drift. Now
  re-checking a price re-orders the providers for free, and a test proves the ordering follows a
  synthetic table rather than the provider names. The founder's brief assumed Gemini Flash would
  rank first; at current prices it does not. For usewarden's representative call (500 in / 50 out
  — the documented shape of its fixed prompt, not an invented average) the order is
  `openai/gpt-5-mini` ~$0.000225, `gemini/gemini-3.7-flash` ~$0.000563,
  `anthropic/claude-haiku-4-5` ~$0.000750. The research decided it, as instructed.
  "Capable" is load-bearing: every vendor sells cheaper — `gpt-5-nano` at $0.05/$0.40,
  `gemini-3.5-flash-lite` at $0.30/$2.50 — and usewarden does NOT default to those. The judge is
  a security control whose failure mode is a *missed* drift; it fails quiet. Defaulting to a
  high-throughput tier whose judgement quality usewarden has never checked would make a user's
  first judge call an unadvertised experiment on a control they are trusting. Anyone who wants
  that trade takes it with one line of `judge.model`. — confidence 8 — a live A/B showing a lite
  tier matching the default on the sabotage suite would change the default.**

- **[D-088] The OpenAI price in the table was wrong by 2x and is corrected — rationale: it read
  $0.125/$1.00; developers.openai.com/api/docs/pricing gives gpt-5-mini at $0.25/$2.00 (checked
  2026-08-20). Token counts are recorded exactly and were never affected, so this could not
  corrupt usage — but it halved every OpenAI dollar figure usewarden reported, which is the
  direction that flatters the tool and misleads the user deciding whether the guardian is worth
  its cost. It also silently changed the new cheapest-capable ordering, which is precisely why
  that ordering is computed from the table and not memorised. Gemini's $0.75/$3.75 was confirmed
  correct, with the note that it is an introductory rate ending 2026-12-31 and rising to
  $1.50/$7.50 — `pricingStaleness()` cannot see a *scheduled* increase, only an old check date,
  so the date is recorded in a comment as well. Anthropic's $1.00/$5.00 was confirmed unchanged.
  — confidence 9 — n/a.**

- **[D-089] `SECURITY.md` publishes NO email address, and private vulnerability reporting was
  found switched off — rationale: the file named GitHub private vulnerability reporting as the
  preferred disclosure route while that feature was DISABLED on the repository, and its stated
  fallback was a literal `SECURITY_CONTACT_PLACEHOLDER`. A reporter following the document found
  no button and no address: the project had no working security contact at all. A documented
  channel that does not exist is worse than an undocumented one, because someone follows it,
  lands nowhere, and files publicly instead. PVR is now enabled (as is secret scanning and push
  protection, both of which were off on a public repository), `scripts/apply-hardening.sh`
  enables all three so they cannot drift back, and `verify-hardening.sh` checks them.
  On the address: the instruction that queued this said to set it to `<PUT YOUR ADDRESS HERE>`
  and, in the same breath, to verify no placeholder remained anywhere — which cannot both be
  satisfied. Rather than invent one or publish the founder's personal address, the file now uses
  a route that needs no address: a personal address in a public SECURITY.md cannot be rotated and
  cannot be un-published, and a stale one bounces, converting a responsible reporter into a
  public issue. A test asserts the file publishes no email address at all, so adding one later is
  a deliberate act that updates a test rather than a quiet edit. — confidence 8 — a role alias on
  a domain the founder controls would be a reasonable addition; a personal mailbox would not.**

- **[D-090] `verify-all.sh` now fails when the DOCS go stale, not when the suite grows —
  rationale: the test count in README.md and FINAL-REPORT.md went stale three times during this
  build (197 → 247 → 324 → 356) and nothing noticed, because a number written in prose has nobody
  checking it. The gate compares the count stated in the README against the count the suite
  actually reports. Note the polarity, which is the whole point and the lesson of D-084: it fires
  when the documentation rots, never when the thing it documents is maintained. A gate with the
  other polarity teaches people to stop maintaining the thing. — confidence 9 — n/a.**

- **[D-091] A scanner must distinguish USING a bad pattern from NAMING it — rationale: this rule
  is written down because it was learned three times in two days, each time by shipping a check
  that failed on the record of the fix rather than on the defect. The `--no-verify` scan flagged
  the PROGRESS.md row asserting the guard (D-084). The placeholder scan flagged
  `verify-hardening.sh`, whose job is to grep for the placeholder. Then it flagged DECISIONS.md
  and FINAL-REPORT.md for explaining that the placeholder had been removed. Every time, the
  obvious fix is to add the file to an allowlist, and every time that is the wrong fix: an
  allowlist that grows whenever somebody documents or checks the thing it protects trains people
  to widen the scanner instead of reading the finding, and eventually the honest record becomes
  the thing that fails the build. The right fix is to scope by CONSEQUENCE - where can this
  string actually do harm? For `--no-verify`, in a file that can execute. For the security
  placeholder, in the document a reporter reads. Prose that names a pattern in order to explain
  it is not the pattern. — confidence 9 — n/a.**

## Gemini verified live, and the key-format bug it exposed (2026-08-20)

- **[D-092] Gemini is marked verified; anthropic and openai are not, and a test enforces the
  difference — rationale: the live check passed on the second attempt (367 in / 40 out,
  $0.000425, ledger delta equal to cost, drift detected at high confidence, exit 0), so a metered
  provider has now completed a real judge call end to end — the one thing 40 contract tests
  cannot establish, because a renamed usage field or a retired model id looks identical to a
  passing suite. The pressure at this moment runs one way: one provider passes and it becomes
  tempting to let the other two ride on it. They have no live evidence and their rows still say
  UNVERIFIED-LIVE. `tests/packaging.test.ts` now parses the status rows out of README.md and
  docs/HOOK-MATRIX.md and fails if a provider without live evidence is marked verified, and
  separately cross-checks the token counts and cost quoted in the README against the recorded
  artifact — which immediately caught a real drift, because I had quoted figures from one run
  while the artifact recorded another. — confidence 9 — a passing check for either other provider.**

- **[D-093] LAUNCH-BLOCKING: `AQ.`-format Gemini keys were never redacted — rationale: Google
  issues Gemini keys as `AQ.` plus about 50 characters (53 total); the legacy shape is `AIza`
  plus 35 (39 total). Both are live in the wild simultaneously, since an existing key keeps
  working while new ones are issued in the new shape. Every credential control in this repository
  knew only the legacy shape, so a key belonging to anyone who signed up recently was invisible
  to all four of them: `redact()` — which is what stands between a credential and an incident
  row, the dashboard, a log line, and the judge payload sent to a THIRD PARTY; the pre-publication
  scanner, which would have passed a repository with a leaked new-format key in its history;
  `judge-live.sh`'s scrubber; and the aggregation service's content gate. For a security tool
  this is the worst class of defect available: silently leaking the credential of a user who did
  nothing wrong except sign up this month. All four now handle both formats.
  The deeper fix is that `redact()` no longer relies only on shape. It also strips the EXACT
  value of any credential this process was configured with, read from the environment. That is
  redaction by identity, it depends on no vendor format at all, and it would have caught this
  with no pattern for `AQ.` in existence. Google publishes no key-format specification, so a
  prefix list is a guess with a shelf life — which is the same lesson as D-081's reader
  denylist, learned again in a place where the cost was a leaked key rather than a bypassed
  check. — confidence 9 — n/a.**

- **[D-094] A credential's shape is inspected BEFORE the call, and the diagnosis is attached to
  auth failures — rationale: the first attempt failed with a bare `HTTP 401 AUTH. The API key was
  rejected`, against a 106-character doubled paste. Diagnosing it meant ruling out the auth
  header, the API version, and the model id one at a time before the credential became the
  suspect — and the answer was visible in the value's shape the whole time. A 401 is the
  provider's answer to "is this key valid"; it is not an answer to "did you paste it twice", and
  the difference was an evening. `inspectKeyShape()` classifies doubled, truncated,
  wrong-provider, whitespace-contaminated and unrecognised shapes, and `maybeJudge` attaches the
  result to any AUTH failure. Everything it reports is a coarse property — a length, a prefix
  class, a position — assembled from constants and integers; it never reads, stores, returns or
  logs the value, and a test drives every branch asserting the credential body never appears in
  any message.
  It NEVER refuses the call. Google changed the Gemini key format without publishing a spec, and
  a shape check that rejected an unrecognised value would have locked out every new user that
  week — the over-guard trap of spec 3A.6, applied to a credential. Unknown shape is a warning
  with a pointer to where a correct key comes from, and the call goes ahead.
  One refinement came from the tests: bounded length ranges per format. Unbounded, an `AQ.` key
  concatenated with an `AIza` key is still all url-safe base64 after the prefix, so it matched the
  current-format pattern and was reported as a perfectly good key. Concatenation is now caught by
  a known prefix appearing at a non-zero index in a value longer than any single key of that
  format — both conditions required, because a prefix can occur mid-key by chance. — confidence 9
  — a vendor adopting a format that collides with another vendor's prefix.**

## Launch readiness: adversarial review, discoverability, BYOK, cost ceiling (2026-08-20)

- **[D-095] "A firewall for your AI coding agents" was an overclaim and is gone — rationale: read
  as a hostile HN commenter, it is the first thing to attack and it does not survive. A firewall is
  a chokepoint that cannot be bypassed; usewarden intercepts what an agent *declares* it is about
  to do, through each vendor's hook system, and an agent that does not fire hooks or misreports its
  tool input is simply not covered. The word promises containment the design cannot deliver, and
  the gap between the promise and the product is exactly where a security tool loses its
  credibility — permanently, and with the people whose opinion matters most. "Guardrail" is
  accurate. Changed in the CLI usage banner, the landing page, the README and the launch drafts,
  and the landing page now states "not a firewall and not a sandbox" in its second paragraph rather
  than burying it in a limitations section. A test fails the build if the word returns as a claim.
  — confidence 9 — n/a.**

- **[D-096] "88.2%" became "15 of 17" — rationale: three significant figures from seventeen
  samples. The percentage is arithmetically correct and rhetorically dishonest: it implies a
  measurement precision the sample size cannot support, and it invites exactly the reply it
  deserves. The suite still prints the percentage, because that is a real computed output and
  rewriting a capture would be falsifying evidence; what changed is that no *claim* quotes it.
  Same class of error as the savings estimate in D-072, in the opposite direction — there the fix
  was to widen a number into a band, here it is to stop narrowing a fraction into a decimal.
  — confidence 9 — n/a.**

- **[D-097] "22 catches in real sessions" became "9 Layer-1 blocks and 13 Layer-2 drift warnings"
  — rationale: the total is true and reads as twenty-two blocked attacks. It is nine blocks and
  thirteen advisory warnings from a sampled judge, which is a materially weaker and much more
  interesting claim. Queried from the live store rather than recounted from memory. Reporting a
  composite as though it were its strongest component is precisely what docs/METRICS.md forbids
  usewarden from doing to its own users, and the launch copy does not get an exemption.
  — confidence 9 — n/a.**

- **[D-098] The launch copy leads with the reader's problem, in the reader's words — rationale:
  read as a developer with eight seconds, every draft opened by describing the product or telling
  the story of its bugs. Both are stories about the tool. The eight-second reader is deciding
  whether this is *their* problem, and the answer has to be in the first sentence. Practitioner
  language was researched rather than guessed: `rm -rf` on the wrong directory has four public
  issues on anthropics/claude-code (#10077, #29082, #30700, #37331 — each verified to exist via
  the API before being cited), and "context rot" is the term in circulation for an agent that
  forty messages in contradicts a decision you made together and edits a file it no longer
  remembers reading. The six-defects story is still the best thing the project has to say; it is
  now the second paragraph, where it keeps a reader rather than filtering one. A test asserts the
  Show HN body does not open with "Usewarden is". — confidence 8 — n/a.**

- **[D-099] Discoverability is problem-shaped everywhere, because the name has no search volume —
  rationale: `usewarden` is a coined word nobody types, which is a permanent constraint rather
  than a launch-day problem. npm keywords and GitHub topics were rewritten as *search queries* —
  what the problem is called, what the user wants prevented, and which agent misbehaved — and the
  previous topic set (`ai`, `ai-agents`, `hooks`, `security`, `cli`) was dropped for being so
  broad that the repo is on page forty of each. The README gained a real heading hierarchy and a
  FAQ, because both search engines and retrieval-time assistants index headings and surface FAQ
  entries as direct answers. `launch/DISCOVERABILITY.md` records where AI-assisted discovery
  actually pulls from — training data (closed at launch, cannot be bought), retrieval (responds to
  writing, rewards problem-shaped headings), and community discussion (slowest, highest leverage,
  hardest to fake) — and the cadence conclusion: sustained problem-shaped artifacts beat a single
  launch spike, because the spike optimises for the path that matters least. The caution is
  recorded in the same file: assistants repeat confident claims as readily as accurate ones, and a
  claim this project cannot back becomes very hard to retract once something that does not cite
  its sources is repeating it. — confidence 8 — n/a.**

- **[D-100] BYOK is asserted in two directions, and both are tested — rationale: "bring your own
  key" makes two separate promises that fail differently. That usewarden ships no key material of
  the maintainer's: a credential in a published tarball is unrecoverable, since the version cannot
  be unpublished from every mirror and cache. And that usewarden needs no key at all: Layer 1 is
  deterministic and free, which is the answer to "what does this cost me" and had never been
  stated plainly in the README. Both are now verified rather than promised — a test resolves the
  actual `files` allowlist and scans every shipped file against ten credential patterns (with a
  meta-test proving those patterns match a real credential shape, so the scan cannot be
  vacuous), reports the FILE and pattern name but never the match (a failing test log is a place a
  leaked credential would be published a second time), and separately asserts the README says it.
  Measured, not assumed: Layer 1 catches 4/4 demo scenarios with every provider variable unset and
  the local CLI disabled, and the judge degrades to a single actionable sentence. — confidence 9
  — n/a.**

- **[D-101] The aggregator gets a HARD global daily ingest ceiling, and the per-submitter limit is
  documented as insufficient — rationale: the service's bill is the operator's, not the user's,
  and an open ingest endpoint without a global ceiling converts somebody else's spare bandwidth
  into an invoice. The existing per-submitter rate limit does not solve this and it is important
  to say why rather than let it look sufficient: it keys on a salted hash of the remote address
  and is deliberately amnesiac (D-076), which is right for privacy and means it is trivially
  evaded by anyone with a handful of addresses. It bounds accidents; only the global ceiling
  bounds spend. Set at 20,000 accepted submissions per UTC day — 2x expected volume at 10,000
  installs — checked BEFORE the per-submitter limit and before a single byte of body is read,
  because a ceiling checked after the work is not a ceiling on the work. Past it the service
  returns 503 and folds nothing; it does not queue, because a queue is a slower way to spend the
  same money, and the client's fire-and-forget transport discards a 503 silently. Worst-case
  monthly cost is documented at 100 / 1,000 / 10,000 installs and at the ceiling, with every
  assumption stated; the honest answer at all four is "the price of the smallest instance you can
  rent", and the ceiling exists so a hostile client cannot change that. A test asserts the
  documented table still covers every scale and that the number in the doc matches the number in
  the code. Still NOT deployed. — confidence 9 — a decision to submit more than once per install
  per day, or an install base past the ceiling, both of which require raising the constant and the
  table in the same commit.**

## Support bot, dashboard, and platform rules (2026-08-20)

- **[D-102] Platform rules, researched from primary sources where reachable, and marked
  UNVERIFIED where not — rationale: these changed in 2026 and will change again, so the date and
  the reachability matter as much as the finding. **Hacker News** bans generated AND AI-edited
  comments outright — "Don't post generated comments or AI-edited comments. HN is for conversation
  between humans" — promoted from long-standing moderator practice, enforced by community flagging
  rather than detection software. Verified via multiple secondary reports of the guidelines change;
  the guideline text itself is short and quoted. **X**: pay-per-use became the default for new
  developers in Feb 2026 ($0.015/post, $0.20 with a link, $0.005/read); secondary sources state
  keyword-triggered auto-replies are prohibited while scheduling and AI drafting are permitted.
  **X's own pages could not be read** — help.x.com 403, developer.x.com 402 — so that constraint is
  recorded as UNVERIFIED-FROM-PRIMARY-SOURCE and the design assumes the strictest reading.
  **Reddit** blocks the fetcher entirely, so per-subreddit rules could not be read at all; only the
  Reddit-wide behavioural definition of spam is recorded, with an instruction to read each sidebar
  before posting. **npm downloads** and **GitHub traffic** endpoints WERE read from their primary
  docs and are quoted in `ops/dashboard/src/sources.ts` with their limits (npm: 18 months, counts
  processed after UTC midnight; GitHub traffic: last 14 days, write access required).
  Saying "I could not read this" is the entire value of the entry. — confidence 9 — any of these
  changing, which they will.**

- **[D-103] The support bot is EXTRACTIVE, not generative: it quotes the repository or it declines
  — rationale: the founder has no technical knowledge and cannot correct the bot, which makes a
  confident wrong answer worse than no bot and worse in a way nobody would catch. Mitigating
  hallucination was not good enough; the design eliminates the category. The bot retrieves passages
  from the repository's published documents with BM25 over heading-delimited chunks and QUOTES THEM
  VERBATIM with a link. A model, when configured at all, is used ONLY to suggest labels — it never
  writes, summarises or paraphrases, and there is no code path in which model prose about the
  product reaches a reader as fact. A test reads the cited file and asserts every substantive
  quoted line appears in it verbatim. The cost is that answers read like quotations, which for a
  tool whose pitch is "verify, don't trust" is the right trade. Internal documents (PROGRESS.md,
  CLAUDE.md, SPEC-BUILD.md, ops/) are excluded from the corpus and a test enforces it: a bot that
  quotes the build record into a public issue has published it. — confidence 9 — n/a.**

- **[D-104] Retrieval needs a COVERAGE gate as well as a score, and the eval set is what proved it
  — rationale: BM25 alone answered an unrelated web-server configuration question by quoting
  SECURITY.md, scoring 5.2 on generic words alone. (The question is deliberately not reproduced
  here: writing an eval case into a document the bot retrieves from puts the answer in the corpus
  and the case stops testing retrieval. That happened, and a test now enforces the separation.) Score
  measures how WELL terms match; it does not measure how MANY do. Requiring that a third of the
  query's distinctive terms actually appear is what separates "related" from "shares some English".
  Source weighting was the second fix: DECISIONS.md and FINAL-REPORT.md are enormous, contribute
  most chunks, and are written in this project's jargon, so BM25 handed them almost every query —
  and they are the wrong answer for a support question, which should be shown the README. They stay
  in the corpus and are outranked. — confidence 8 — n/a.**

- **[D-105] The eval set found four DOCUMENTATION gaps, and the honest number is 20/20 on a set I
  iterated against — rationale: the first run scored 11/20. Two failures were the coverage gap
  above; two were my eval demanding a canonical file when another document answered just as well
  (verified by reading the passage the bot actually quotes, not by widening until green); one was a
  real excerpt bug — retrieval correctly picked the README FAQ and the excerpt then quoted the FAQ's
  FIRST entry, which is about telemetry, producing an answer that was confidently irrelevant.
  Excerpts are now query-focused. The remaining four failures were the README genuinely not
  answering "why not use my agent's own allowlists", "isn't this just a wrapper around hooks",
  "what Node version", and "how do I uninstall" — so the README gained four FAQ entries and the
  eval went to 20/20.
  **That number must be read with its caveat: it is 20 of 20 on twenty questions I wrote, after
  four rounds of fixing what it exposed.** It is evidence the bot answers the questions I could
  think of; it is not a measure of accuracy on questions I could not. The eval's real value was
  finding the documentation gaps, which is a better outcome than a high score. — confidence 7 —
  real user questions, which will differ from mine.**

- **[D-106] The bot is a separate isolated service, and the blast radius is documented rather than
  asserted — rationale: it posts in public under the project's name, so the question is not whether
  it will be attacked but what an attacker gets. `ops/BOT-SCOPE.md` states the ceiling: a wrong
  label and one wrong sentence, on one public issue, signed as automated. That ceiling holds
  because the model never writes the answer, `issues: write` permits nothing but commenting and
  labelling, `persist-credentials: false` means it cannot push, one-comment-per-issue and a 30/day
  cap bound the volume, and it is stateless between issues so a compromised run cannot carry into
  the next. Two independent kill switches, either sufficient, and the repository variable is also
  the ON switch so merging the workflow does not start it. Five prompt injections are driven
  through the real path — leak the prompt, post a link, claim a fix, impersonate the maintainer,
  exfiltrate the environment — each asserting the hostile instruction really reached the bot before
  asserting nothing changed. — confidence 9 — n/a.**

- **[D-107] The X bot drafts and does not post, and the reason is written down — rationale: the
  brief asked for replies to mentions. The strictest reading of X's automation rules, as reported
  by the secondary sources available, is that a reply posted the instant an account is mentioned is
  a keyword-triggered auto-reply, which is prohibited. X's own pages were unreachable, so the
  constraint could not be confirmed. Shipping something that might get the account suspended on day
  one to satisfy a brief written before that research would be the wrong order of priorities, so
  `AUTO_POST` is false and the bot writes drafts a human sends. Every other rule in the brief —
  mentions and own-thread replies only, never follow, like, repost, DM, or reply into someone
  else's thread — is enforced in code regardless of that switch, so flipping it later cannot widen
  what the bot engages with. `ops/X-BOT-SETUP.md` makes reading the actual policy step 1, and
  records the pay-per-use cost ($0.20 per post containing a link) as an argument for drafting
  rather than posting at all. — confidence 8 — the founder reading the primary policy.**

- **[D-108] The dashboard's North Star is installs that produced a first catch, and it is honest
  about not having it yet — rationale: spec §3B fixes the activation metric as "usewarden caught
  something in a real session", not "installed", so that is the number displayed largest — and it
  currently displays a dash with the reason, because it cannot be computed from any public source
  and the aggregator is not deployed. It lights up automatically when it is: the telemetry payload
  already carries `checklist.first_catch` and `counts.live_catches`. Downloads are shown below it,
  smaller, with the caveat printed every time that they count CI runs, mirrors and cache misses and
  are traffic rather than users. Every reading carries its source and the moment it describes, and
  an unfetchable figure prints "unavailable" and why — never a zero, which would read as "nobody
  came" rather than "we could not ask". When the impact numbers do appear they are labelled a
  FLOOR, because opt-in telemetry plus k-anonymity suppression means the true number is higher and
  unknowable. — confidence 9 — n/a.**

## Local install, visual dashboard, and a false positive found in production (2026-08-20)

- **[D-109] The founder's private repositories are protected WITHOUT a byte written into any of
  them — rationale: the task said to pick the project where a mistake would cost most and write a
  policy file there, with an explicit out if the path rules forbade it. They do. CLAUDE.md §1
  forbids reading, writing or running any command against a set of the founder's private project
  paths, and §1 is not overridable by a task instruction; every project in `~/dev` except this one
  falls under it. Rather than pick a lesser project, the protection went into the MACHINE-WIDE
  policy at `~/.usewarden/usewarden.yaml`, which names those paths, the documents directory, and
  the financial-data and model directories as permanently forbidden. That is strictly better than
  a per-project file: it protects them from an agent working ANYWHERE, it cannot be deleted by
  someone tidying a repo, and it required touching none of them. `allowed_paths` was also narrowed
  from the whole home directory — the starter policy's default — to three specific project
  folders, because "the agent may work anywhere in your home directory" is not a scope.
  (The paths themselves are deliberately not named here. This file is published; the operator's
  private project names are exactly what `scripts/scan-identity.txt` and the pre-publication scan
  exist to keep out of it, and naming them in a decision entry would have leaked them the first
  time this document shipped.) — confidence 9 — the founder adding a new project, which is one
  line.**

- **[D-110] Installing globally is a write outside the repository, and it is disclosed rather than
  slipped in — rationale: §3 limits writes outside `~/dev/warden` to the product's own hook
  registrations. `npm link` puts a symlink in the Homebrew node prefix, which is neither. The
  founder asked for it explicitly, on their own machine, for their own product, and it reverses
  with one command — so it was done, and it is named here and in `ops/MY-SETUP.md` rather than
  left for someone to discover. The agent config writes ARE covered by §3, and each was preceded
  by usewarden's own timestamped backup plus an independent copy under `backups/pre-install-*`
  taken before usewarden ran at all. — confidence 8 — n/a.**

- **[D-111] usewarden blocked its own maintainer writing its own policy file, and the fix is a
  real narrowing — rationale: found in production, mid-task, not by any test. Writing a policy
  containing `- "**/<dotenv glob>"` inside a heredoc was BLOCKED: `dotenvSegment` splits a command
  on shell separators, and a YAML list item parses as a segment whose first token is `-`, which
  was then treated as a command reading a credential file. The result was that a usewarden policy
  listing the patterns it protects could not be written while usewarden was running — the
  over-guard trap of spec §3A.6 in its purest form, and considerably funnier from the outside.
  The fix is that a verb must look like a command name (`^[A-Za-z_][A-Za-z0-9_.+-]*$`): a leading
  `-` is a flag or a bullet, punctuation is not a program, and neither can read anything. Real
  reads via cat, sed and cp still block, asserted in the same test. This is the eighth defect in
  this codebase found only by running the thing for real. — confidence 9 — n/a.**

- **[D-112] The web dashboard's hero is a stat tile, not a chart, and its empty state says "Not
  measurable yet" — rationale: the North Star is a single headline magnitude, which the form
  heuristic puts in a stat tile; a chart of one number is decoration. The first render used a
  116px em-dash for the unavailable state and it read on screen as a **redaction bar** — something
  withheld rather than something not yet measurable. Looking at the render caught it; the
  validator cannot, because it checks colour, not layout. Palette (`#3b6fd0` series, `#0ca30c`
  good) was run through the validator rather than eyeballed: lightness band, chroma floor, CVD
  separation, normal-vision floor and contrast all PASS. Sparklines are single-series so carry no
  legend, and return EMPTY rather than drawing a flat line at zero, because a flat line reads as
  "measured and steady" when the truth is "no data". Note: the task named a `frontend-design`
  skill; no such skill exists here — `dataviz` is the one whose scope matches and is what was
  used. — confidence 9 — n/a.**

- **[D-113] Clone counts are labelled as automated traffic, on the dashboard itself — rationale:
  35 unique cloners against 1 unique visitor. Research found that GitHub's traffic API exposes no
  bot filter at all, and that `uniques` is IP-based, so it merges an office behind one NAT and
  splits a home connection across several. There is no way to detect bots; there IS one checkable
  fact — a person nearly always views a repository before cloning it, so clones far exceeding
  visitors is the signature of mirrors, crawlers and CI. `clonePlausibility()` computes that ratio
  and the dashboard prints a plain-English caution beside the figure. This is docs/METRICS.md
  applied to our own reach numbers: showing an investor a figure a knowledgeable person would
  discount in one second spends credibility for nothing, and it is the same
  composite-as-strongest-component failure the product refuses to commit against its own users.
  — confidence 9 — GitHub shipping a bot filter, which would be welcome.**

- **[D-114] The triage bot was NOT enabled, because the instruction's own condition could not be
  met — rationale: the task said to set `TRIAGE_BOT_ENABLED=true`, open a test issue, watch the
  comment land, and "do not leave the bot enabled unless you have seen one good comment land." The
  workflow is not on the public repository — putting it there is a push to `djayamah/usewarden`,
  exception 1 — so no workflow would run and no comment could land. Setting the variable would
  have satisfied the letter of step one while guaranteeing the condition in the last sentence
  could never be checked, which is the opposite of what was asked. The variable is left unset and
  the bot's real output was produced locally instead and quoted verbatim in the report.
  **Watching it work was the valuable part regardless:** the first comment on the most obvious
  new-user question ("do I need an API key, does it send my code anywhere") was BAD — it routed a
  beginner's question as a SECURITY report, told them to close their issue and file a vulnerability
  advisory, and cited nothing. Two defects behind it: `/api key/` alone matched as a
  credential-format signal, and retrieval declined because a realistic issue body dilutes the
  coverage fraction that short eval questions never did. Both fixed; the eval set had given false
  confidence precisely because its questions are short and clean and a real issue is neither.
  — confidence 9 — the founder merging the workflow, after which this should be re-run for real.**

- **[D-115] The execute bit came back, in the one place D-012's fix did not cover — rationale:
  D-012 was a built CLI with no execute bit; every hook died with EACCES while `status` said
  PROTECTED, and it is the defect this project's entire design premise came from. It was fixed in
  the HOOK path, by registering `<abs node> <abs script>` so the script never needs to be
  executable. `package.json` also exposes `dist/src/cli.js` as a global `bin`, and a global
  install runs it DIRECTLY. `tsc` writes 0644, so `npm link` produced a `usewarden` command that
  answered every invocation with "permission denied" — found by installing it on this machine,
  not by any test, and it would have hit every `npm i -g usewarden` user on day one. The build
  now chmods 0755 itself and three tests assert it: the mode, the shebang, and that the build
  script does the chmod rather than trusting the packager. "npm probably sets the mode on bin
  entries" is precisely the assumption that produced D-012 the first time. — confidence 9 — n/a.**
