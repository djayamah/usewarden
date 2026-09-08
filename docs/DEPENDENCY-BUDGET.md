# DEPENDENCY BUDGET

Every dependency is an install-script surface, a maintainer account that can be compromised, and
a transitive tree you did not choose. ChainDrop (4 Aug 2026) turned 444 packages into malware
carriers through exactly that chain. For a tool whose entire pitch is "I watch your agents for
you", the dependency count is not a matter of taste — it is part of the product claim.

## Runtime dependencies: **zero**

```
$ node -e "const p=require('./package.json'); console.log(Object.keys(p.dependencies??{}).length)"
0
```

Asserted by `tests/packaging.test.ts` → *usewarden has ZERO runtime dependencies*.

| Capability | What most projects reach for | What usewarden uses instead | Why |
|---|---|---|---|
| SQLite | `better-sqlite3` (native addon, **install script**, node-gyp, prebuilt-binary failures) | `node:sqlite` | §3A.1 makes this a security requirement, not a preference: the native addon's install script is the ChainDrop mechanism. Stability 1.2 (RC), unflagged since 22.13.0. Fallback documented below. |
| YAML | `yaml` / `js-yaml` (2-4 transitive) | a ~230-line strict subset parser in `src/policy/yaml.ts` | A `usewarden.yaml` can arrive from an untrusted clone (T-06). A full engine's feature surface — tags, anchors, merge keys, multi-document — is attack surface usewarden does not need. The parser rejects each by name. |
| CLI colour | `chalk` / `picocolors` | 9 ANSI constants in `src/term.ts` | Nine constants and a `NO_COLOR` check is less code than the dependency's own README. |
| CLI arg parsing | `commander` / `yargs` (10-40 transitive) | `process.argv` + a `switch` | Usewarden has 15 commands and no nested subcommands. |
| HTTP client | `axios` / `node-fetch` | built-in `fetch` | Native since Node 18. |
| Test runner | `vitest` / `jest` (300+ transitive) | `node --test` | Built in since Node 18. |
| HTTP server | `express` / `fastify` | `node:http` | The dashboard is two read-only GET routes. |
| Headless browser | `puppeteer` / `playwright` (**both ship a postinstall that downloads a browser**) | an already-present `chrome-headless-shell`, probed by `scripts/screenshot.sh` | Adding a postinstall-script devDependency to prove a security product is secure would be self-defeating. The script fails loudly if no browser is found rather than skipping the check. |
| **Shell parsing** | `shell-quote`, `sh-syntax` (WASM), `tree-sitter-bash` (node-gyp) | a ~330-line lexer in `src/engine/shlex.ts` | Researched and decided 2026-09-08 — the long version is below, because this is the one place where "write it ourselves" is the *less* obvious answer and needs defending. |
| LLM SDK | `@anthropic-ai/sdk` + `openai` + `@google/genai` | raw `fetch` against the documented wire formats | The judge is provider-agnostic; three SDKs to buy one POST each. Recorded in DECISIONS D-008 with the condition that would reverse it. |

## Development dependencies: **two**

| Package | Version | Why it is here | Install script? | Transitive count |
|---|---|---|---|---|
| `typescript` | ^5.7.3 | Compiles `src/` and `tests/` to `dist/`. Never present at runtime; not in the published `files` allowlist. | none | 0 |
| `@types/node` | ^22.10.5 | Type definitions only; zero emitted code. Held at the **22** line deliberately, matching `engines.node`, so the compiler enforces the LTS floor rather than letting a newer API slip in. **This is now enforced** by an `ignore` rule in `.github/dependabot.yml` and asserted by `tests/config-references.test.ts` — see *The `@types/node` ceiling* below. | none | 1 (`undici-types`) |

```
$ npm ls --all --omit=dev   # runtime tree
usewarden@0.1.0
(empty)
```

Asserted by `tests/packaging.test.ts`:
- no `preinstall` / `install` / `postinstall` / `prepare` / `prepublish` in usewarden's manifest;
- no entry anywhere in the committed lockfile has `hasInstallScript` or any of those scripts;
- every lockfile entry carries an integrity hash.

## Rules for adding one

A dependency may be added only with a row in the table above recording:
1. **weekly downloads** and **last publish date** at the time of adding;
2. **maintenance status** — how many maintainers, and when the last commit was;
3. **transitive count** (`npm ls --all` after adding);
4. **whether it or anything beneath it runs an install script** — if yes, the answer is no;
5. what usewarden would do instead if it were removed.

And the `min-release-age` cooldown in `.npmrc` applies to it like everything else.

## `min-release-age`

`.npmrc` sets `min-release-age=7`, so npm refuses to install any version published in the last
seven days. That is the single cheapest defence against a ChainDrop-shaped event: the 2026-08-04
worm was detected and pulled within hours, and a seven-day cooldown would have meant no usewarden
contributor ever installed a poisoned version.

**The unit is DAYS, not minutes** — found the hard way (DECISIONS D-009): `min-release-age=1440`
made npm refuse `@types/node@^22.10.5` because it treated 1440 as 1440 *days*. Requires npm
≥ 11.10.0; `scripts/verify-hardening.sh` checks the local version and says so if it is older.

## The documented fallback for `node:sqlite`

`node:sqlite` is Stability **1.2 — Release Candidate** ("stable and recommended for production
use"). If a blocking defect appears — data loss, WAL corruption, or a behaviour split between
Node 22 and 24 — the fallback is `better-sqlite3`, and taking it means:

- accepting a native addon **with an install script**, which contradicts T-01;
- so the README security section and this document must both be amended to say so, prominently,
  in the same release;
- and `scripts/pre-publish-check.sh` must be updated, because its no-install-scripts assertion
  will (correctly) start failing.

That deliberate friction is the point. Measured on this build machine: `node:sqlite` opens,
WAL-enables and round-trips identically on Node 22.22.0 and 25.5.0
(`verification/phase0-node-sqlite.txt`).

---

## The `@types/node` ceiling — measured 2026-09-08, PR #31

**Rule: `@types/node`'s major must equal the major in `engines.node`. Raise them together or not
at all.** Enforced in `.github/dependabot.yml` (`ignore` → `version-update:semver-major`) and
asserted by `tests/config-references.test.ts`. Minor and patch updates inside the 22 line still
come through; only the major jump is held.

Dependabot PR #31 (`@types/node` 22.20.1 → 26.3.0) was checked properly rather than eyeballed.
Two full trees, one per version, same commit, same TypeScript 5.9.3:

| | typecheck | build | suite, Node 22.22.0 | suite, Node 25.5.0 |
|---|---|---|---|---|
| `@types/node` 22.20.1 | exit 0 | exit 0 | 745 / 747 | 745 / 747 |
| `@types/node` 26.3.0 | exit 0 | exit 0 | 745 / 747 | 745 / 747 |

Byte-identical. (747 was the suite size when this was measured; the same run then added the
config-reference and firing-evidence tests, so `npm test` reports more now.) The two failures are
the same two in both columns — `packaging.test.ts` tests that
shell out to `git grep`, running in a copied tree with no `.git`; both report *"setup failed"*
rather than passing, which is §4.2 working as intended. CI on the PR itself was green on Node 22,
24 and 25 plus macOS. **The bump does not break anything.** It was still closed, and this is why:

```
const p = new URLPattern({ pathname: '/hooks/:name' });
```

| | result |
|---|---|
| `tsc` with `@types/node` 22.20.1 | **exit 2** — `error TS2304: Cannot find name 'URLPattern'` |
| `tsc` with `@types/node` 26.3.0 | exit 0 |
| Node v22.22.0 | **`ReferenceError: URLPattern is not defined`** |
| Node v25.5.0 | ok |

`engines.node` is `>=22.13.0`, so users install usewarden on Node 22. `URLPattern` became a global
in Node 24. On the 22 types the **typechecker refuses code that cannot run on our own floor**; on
the 26 types it accepts it, and the mistake reappears as a crash on a user's Active LTS.

The 2026-08-19 note below said "CI covers it". Measuring it shows that is only half true. CI runs
the suite on Node 22, so it catches such a mistake **on a line a test actually exercises** — and
nowhere else. That trades a compile-time guarantee, which holds over every line, for a
test-coverage-dependent one, which holds over the lines someone remembered to cover. For a tool
whose central failure mode is *a control that reads as on and is enforcing nothing*, giving up a
working compile-time check to keep a version number current is the wrong direction.

Terminal output: `verification/run-2026-09-08/13-types-ahead-of-engines-demo.txt` and
`12-pr31-ab-results.txt`. Decision D-232.

**When to lift it:** when `engines.node` itself moves off 22, in the same commit. Node 22 reaches
end-of-life 2027-04-30, so this is a dated constraint and not a permanent one.

---

## Evaluated, not adopted — 2026-08-19

Dependabot opened two major bumps on the day the repository went public. Both were built,
typechecked, tested and run through `verify-all.sh` locally. Recorded here rather than merged,
because the budget is the point of this file.

| Bump | Verdict | Effect on the budget |
|---|---|---|
| `@types/node` 22.20.1 → **26.2.0** | passes every gate | none — pure type declarations, no runtime code, not in the tarball. One thing to watch: the major tracks Node's, and types from the 26 line describe APIs that do not exist on the Node 22.13 floor, so a strict build could start accepting code that fails at runtime on LTS. CI covers it — the suite runs on 22, 24 and 25 <br><br> **Superseded 2026-09-08.** "CI covers it" was measured and is only half true: CI catches it on lines a test exercises, and the typechecker caught it everywhere. See *The `@types/node` ceiling* above; PR #31 was closed and the constraint is now enforced in `dependabot.yml` |
| `typescript` 5.9.3 → **7.0.2** | passes every gate, **but changes the shape** | lockfile **4 → 24 entries**. TypeScript 7 is a native binary, so it brings `typescript` plus 20 `@typescript/typescript-<platform>` optional packages |

For the TypeScript bump specifically, the things this project actually cares about were checked
rather than assumed:

- **No install scripts** in any of the 21 new entries. `tests/packaging.test.ts` walks every
  lockfile entry for `hasInstallScript` and the four lifecycle names; it stayed green, and it was
  re-checked by hand.
- **Dev-only.** `npm pack --dry-run` is unchanged at 37 files. None of it can reach a user.
- CI runs `npm ci --ignore-scripts`, so nothing in that tree could execute at install time even if
  it grew a script in a later release.

It is safe as far as anything can be checked automatically. It is also a **native-binary
dependency** arriving in a project that chose `node:sqlite` over `better-sqlite3` precisely to
avoid native addons, and 20 new packages is a real increase in review surface for a two-dependency
project.

### Resolved 2026-09-08 — PR #1 closed, `typescript` major held

Left open for three weeks, which is a decision nobody made. Re-measured properly on a clean tree:

| | typecheck | build | suite, Node 22.22.0 | suite, Node 25.5.0 | emitted `dist/src` |
|---|---|---|---|---|---|
| `typescript` 5.9.3 | exit 0 | exit 0 | 760 / 762 | 760 / 762 | — |
| `typescript` 7.0.2 | exit 0 | exit 0 | 760 / 762 | 760 / 762 | **byte-identical, all 39 files** |

(The two failures are the same `git`-dependent packaging tests described above, in both columns.)

**The emitted JavaScript is byte-identical, so nothing that ships changes — and nothing that
ships improves either.** The build is not a bottleneck: the whole suite runs in about fourteen
seconds. Against zero benefit sits a lockfile going from **4 entries to 24**, the twenty new ones
being prebuilt `@typescript/typescript-<platform>` native binaries — in the project that chose
`node:sqlite` over `better-sqlite3` to keep native binaries out of the tree, and whose *Rules for
adding one* above demand five specific facts per package. Twenty packages, none of them needed
for anything, does not clear a bar this document sets for one.

None of that is an argument that TypeScript 7 is unsafe. It is not: no install script appears
anywhere in the new tree, it is dev-only, it is absent from the tarball, and it is published by
the same people who publish `typescript`. The argument is only that the budget is the point of
this file, and a dependency that changes no output has not made its case.

**Enforced in `.github/dependabot.yml`** as a major-only `ignore`, so the PR is not silently
recreated and 5.x updates still flow. **Lift it when either is true:** TypeScript 5.x stops
receiving fixes, or something here actually needs the 7 line. **Review by 2027-03-01 regardless.**
Terminal output: `verification/run-2026-09-08/26-pr1-ts7-clean-ab.txt` and `27-…-emit-and-surface.txt`.
Decision D-269.


---

## The shell lexer

Layer 1 has to tell a command from a sentence about a command. Doing that with regular expressions
was the source of every false positive left in the labelled corpus (`docs/PRECISION.md`), so
`src/engine/shlex.ts` is a ~330-line quote- and here-document-aware lexer. It answers one question
— at this offset, is this a command name, an argument, a quoted word, or a here-document body? —
and it returns `ok: false` for anything it does not understand, after which every caller falls back
to matching the raw string exactly as before. It cannot open a hole; it can only cost a false
positive.

Three libraries were read and rejected on 2026-09-08: `shell-quote` (no here-document support, and
here-documents were the largest class), `sh-syntax` (a WASM blob instantiated on every hook event),
and `tree-sitter-bash` (node-gyp, the same install-script surface `node:sqlite` was chosen to
avoid). **The full reasoning, and the one condition that would reverse it, are in DECISIONS D-279.**
