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
| LLM SDK | `@anthropic-ai/sdk` + `openai` + `@google/genai` | raw `fetch` against the documented wire formats | The judge is provider-agnostic; three SDKs to buy one POST each. Recorded in DECISIONS D-008 with the condition that would reverse it. |

## Development dependencies: **two**

| Package | Version | Why it is here | Install script? | Transitive count |
|---|---|---|---|---|
| `typescript` | ^5.7.3 | Compiles `src/` and `tests/` to `dist/`. Never present at runtime; not in the published `files` allowlist. | none | 0 |
| `@types/node` | ^22.10.5 | Type definitions only; zero emitted code. Pinned to the **22** line deliberately, matching `engines`, so the compiler enforces the LTS floor rather than letting a newer API slip in. | none | 1 (`undici-types`) |

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
