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
