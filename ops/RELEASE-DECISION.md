# Should 0.1.2 be released now, or does it wait?

**Written 2026-09-08. Readable cold — it assumes you know nothing about this run.**

**Recommendation: RELEASE NOW, as a security release, with the quoted-program escape as the
headline.** The reasoning is below, including the case against, which is real.

**Nothing has been published, staged or dist-tagged.** That is the founder's action and his alone
(`CLAUDE.md` §3 and §7 exception 1). Everything up to the moment before staging is done.

---

## 1. What is wrong with the version that is live

`usewarden@0.1.1` is on npm and is the `latest` tag. On that engine, **a dangerous command hidden
inside a quoted program string is allowed**:

```
sh -c 'rm -rf /'            ALLOWED
env sh -c 'rm -rf /etc'     ALLOWED
timeout 5 sh -c 'rm -rf /'  ALLOWED
rm -rf /                    correctly refused
```

Forty-four of fifty-five wrapper forms are allowed. The bare command is refused throughout, so the
rule works and the wrapper turns it off.

This was tested against **the bytes downloaded from the registry**, checksum-matched to the
registry's own `shasum` and `integrity` fields, not against a local build — and against the policy
that `usewarden init` generates for itself, not a policy written for the test. Evidence:
`verification/escape-class-2026-09-08/01-matrix.txt`.

**Why it happens.** A rule marked `outsideRepoOnly` is skipped when every filesystem-looking
argument resolves inside `allowed_paths`. The tokenizer strips quotes, so `-c 'rm -rf /'` becomes
one token — `rm -rf /` — which resolves *relative to the repository* into `<repo>/rm -rf /`, a path
inside the allowed scope. Everything looks in-scope, so the recursive-delete rule is never
evaluated.

---

## 2. The exposure, measured rather than guessed

### How many people have it

| | |
|---|---|
| Total downloads, all versions, 2026-08-21 → 2026-09-08 | **497** |
| Downloads in the last 7 days | 22 (0.1.1: 14, 0.1.0: 6, 0.0.0: 2) |
| The two spikes | 116 on the 0.0.0 publish day, 288 on the 0.1.0/0.1.1 publish day |

Those two spikes are the shape registry mirrors and security scanners make on a publish day, not
the shape humans make. The honest reading is **an upper bound in the low tens of real installs and
a lower bound near zero**. Two humans have opened issues (#9, #14), so the number is not zero.

**This cuts both ways and it is important to say so.** A small user base is a reason the release is
*cheap*, not a reason it is unnecessary. The people who did install it are exactly the people who
read the package page and believed it.

### Does it need an agent that is already behaving badly?

**No, and this is the finding that decides the question.** The escape does not require malice. It
requires a wrapper — and wrappers are ordinary agent idiom.

Counted against this machine's own record of **8,487 real agent Bash commands**:

| form | occurrences |
|---|---|
| `python3 -c …` | 339 |
| `env … <program>` | 182 |
| `bash -c …` | 89 |
| `node -e …` | 50 |
| `xargs …` | 26 |
| `timeout … <program>` | 17 |
| `sh -c …` | 8 |
| `find … -exec …` | 6 |
| **distinct commands using at least one such wrapper** | **687 — 8.1% of everything an agent ran** |

None of those 687 was an attack. They are how agents normally write shell. So on the published
engine, roughly **one command in twelve arrives in a form that switches the scope check off**, and
a destructive command that happened to be written that way would pass in silence. That is a
coverage hole in ordinary use, not merely an evasion path for an adversary.

### What the package page promises

The npm page for 0.1.1 says the tool "blocks out-of-scope writes, `.env` reads, `rm -rf` and force
pushes". For the wrapped forms it does not. **A guardrail that is wrong about its own coverage is
worse than no guardrail**, because the user stops being careful. That is the argument that carries
the most weight here, and it is not about the download count.

---

## 3. What a release costs

| | |
|---|---|
| Founder's effort | one hardware-key approval on a staged release |
| User migration | none — no config change, no schema change, no flag change |
| Risk of a new defect | the tree passes 833 tests, `verify-all.sh` all gates green, and the baked-surface audit below was done **before** staging rather than after |
| Risk of `doctor` newly failing in someone's CI | none. The new policy check seals whatever it finds on first sight, so a machine upgrading from 0.1.1 starts with seal == policy and the row passes |
| Wasted if we are wrong | one version number |

**The specific failure this could repeat.** 0.1.1 exists *only* because 0.1.0's frozen npm README
said "Not on npm yet" and there is no way to correct that text without a new version (D-239). The
guard against repeating it is §5 below, and it was completed before anything was packed.

---

## 4. The case for waiting, stated fairly

1. **The blast radius is genuinely small.** Low tens of installs, possibly fewer.
2. **The escape removes a protection; it does not add a capability.** Something has to attempt a
   destructive command first. A user with no agent misbehaving is not harmed by this.
3. **There is no security-advisory process here yet.** Shipping a security fix with no GitHub
   advisory and no `SECURITY.md` disclosure entry is half a job.
4. **More is coming.** The policy-drift work in this same release is new and has one week of use
   behind it, none of it on anyone else's machine.

**Why these do not win.** (1) argues about cost, not about correctness, and the cost of *not*
releasing falls on the people who trusted the claim. (2) is true and is exactly the situation the
product is bought for. (3) is a reason to write the advisory, not a reason to leave the defect
live — and the advisory is a Release body and a `SECURITY.md` line, both of which are prepared.
(4) is the only one with real force, and it argues for shipping the escape fix rather than for
holding it; the drift work is additive, defaults to sealing whatever it finds, and cannot make an
existing machine worse.

---

## 5. The baked-surface audit, done BEFORE staging

The npm package page is frozen at publish time. `ops/BAKED-SURFACES.md` lists everything already in
the tree that has never reached npm. Every row was re-read against the working tree on 2026-09-08:

| # | Item | State |
|---|---|---|
| 1 | The honest native-controls comparison | in the tree, not on npm |
| 2 | The shell-redirect and subprocess gaps | in the tree, not on npm |
| 3 | `forbidden_paths` guards the file tools, not the shell | in the tree, not on npm — **and now amended**, see below |
| 4 | The false-positive finding | in the tree, not on npm |
| 5 | `usewarden backup` in the command table and `--help` | in the tree, not on npm |
| 6 | The test count | **corrected to 833 this run**; `verify-all.sh` greps it and agrees |
| 7 | *Free. Local. No account.* on the first screen | in the tree, not on npm — the highest-value row, two strangers asked |
| 8 | `package.json` description leading with **Free** | in the tree, not on npm |

**Two new stale claims were found and fixed this run, which is the point of doing this before
staging rather than after:**

- **Item 3 was true but incomplete.** It said `forbidden_paths` guards the file tools and not the
  shell. It did not say that this includes **usewarden's own policy file**, that this was used on
  the author's machine on 2026-08-29, or that detection now exists. Amended.
- **The command table listed neither `usewarden replay` nor the new `policy --drift` / `reseal`.**
  A command absent from `--help` and the README is a command nobody finds — which is item 5's own
  reasoning, applied to three more commands.

`CHANGELOG.md` is new in this release and leads with the escape.

---

## 6. Version number: 0.1.2, not 0.2.0

Semver would call a release that adds three commands a MINOR bump. **0.1.2 is chosen deliberately
anyway, and the reason is reach.** An npm range of `^0.1.1` — what a `package.json` gets by default
— matches `0.1.2` and does **not** match `0.2.0`. For a fix whose entire purpose is to reach people
who already installed the broken version, the number that reaches them is the right number.

Recorded as **D-283** with confidence 8. *What would change it:* a genuinely breaking change, which
this is not — no config, schema, flag or exit code changes for an existing user.

---

## 7. What is ready, and exactly where it would go

Everything below is done. **None of it has been executed.**

| Step | State |
|---|---|
| Version bumped to 0.1.2 in `package.json` and `src/cli.ts` | done |
| `CHANGELOG.md` written, escape fix first | done |
| Every baked surface audited against the tree | done — §5 |
| `npm test` | 833 pass, 0 fail |
| `./scripts/verify-all.sh` | all gates green, exit 0 |
| The packed tarball built and D2-audited **on the tarball, not the repo** | done — `verification/release-0.1.2/` |
| `npm publish` / `npm stage publish` / `npm dist-tag` | **NOT RUN. Founder only.** |

### The founder's step, when he wants it

```bash
cd ~/dev/warden
npm stage publish            # stages it; the trusted publisher is --allow-stage-publish only
# then approve the staged release with the hardware key, on npmjs.com
```

The registry will refuse a direct publish even if a workflow tried, because the trusted publisher
is configured `--allow-stage-publish` only. That is the enforcement, not the memory of it.

---

## 8. If the answer is "wait"

Then the one thing that should still happen is a line in `SECURITY.md` and a GitHub Discussion
saying that 0.1.1 does not catch wrapped forms, so that anybody who has it can decide for
themselves. Leaving a known coverage hole undisclosed on a security tool is the one option that is
worse than either releasing or waiting.
