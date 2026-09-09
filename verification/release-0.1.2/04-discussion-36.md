**0.1.2 is on npm.** If you are running 0.1.0 or 0.1.1, this one is worth taking:

```
npm install usewarden@latest
```

Two security fixes and one new control. Both fixes were found by this project's own testing, not reported from outside, and both are listed in [`SECURITY.md`](https://github.com/djayamah/usewarden/blob/main/SECURITY.md#known-issues-in-published-versions) against the versions that carry them.

---

## 1. A dangerous command hidden in a quoted program string was allowed

On 0.1.0 and 0.1.1:

```
rm -rf /                        correctly refused
sh -c 'rm -rf /'                ALLOWED
env sh -c 'rm -rf /etc'         ALLOWED
timeout 5 sh -c 'rm -rf /etc'   ALLOWED
```

**44 of 55 wrapper forms were allowed**, measured against the tarball downloaded from the registry rather than a local build. `nohup`, `setsid`, `stdbuf`, `xargs`, `find -exec`, `ssh host '…'`, `perl -e`, `node -e`, `eval` and the rest all worked.

**Why.** A rule marked `outsideRepoOnly` is skipped when every filesystem-looking argument resolves inside `allowed_paths`. The tokenizer strips quotes, so `-c 'rm -rf /'` arrived as a single token — `rm -rf /` — which then resolved *relative to the repository* into `<repo>/rm -rf /`, a path inside the allowed scope. Everything looked in-scope, so the recursive-delete rule was never evaluated at all.

**It needs no misbehaving agent.** That is the part that decided the release. Counted against 8,487 real agent shell commands: `python3 -c` 339, `env <program>` 182, `bash -c` 89, `node -e` 50, `xargs` 26, `timeout` 17. **687 distinct commands — 8.1% of everything an agent ran** — arrive in one of these shapes as ordinary idiom, none of them an attack. Roughly one command in twelve was passing through a guardrail that had switched itself off.

**Four of the eleven that 0.1.1 refused, it refused by accident.** `flock /tmp/l`, `script /dev/null`, `chroot /` and `make -f /dev/null` were blocked only because one of the *runner's own* arguments happened to resolve outside the repository. Give each an in-repo operand and all four allow. Coverage that depends on which filename someone picked is not coverage, which is why this shipped as a class fix rather than four more names on a list.

**The fix is two independent fences.** The effective program is resolved by walking past runner prefixes (`env`, `nice`, `timeout`, `nohup`, `flock`, `chroot`, `find`, `xargs`, `sudo`, `ssh`, …) before the shell test is applied; and any argument token containing whitespace is refused classification, because a token with a space in it is a program string, not a path. Removing the second fence lets twelve runner shapes back through, so both are load-bearing.

**0 of 55 wrapped forms escape on 0.1.2**, verified against the published bytes after release. No change to precision or coverage on the frozen 92-block label set.

**One deliberate behaviour change:** `rm -rf` of an in-repo directory whose *name contains a space* is now refused. Reading and writing it are unaffected. That is the measured price of the whitespace fence and it is written down rather than left to be discovered.

---

## 2. Nothing noticed if usewarden's own policy got weaker

Every check usewarden had watched the **agents' hook registrations**. Not one watched the rules those hooks enforce.

`forbidden_paths` guards the agent's file tools and not the shell — that has always been in the README — and that includes `~/.usewarden/usewarden.yaml` itself. So a policy narrowed by a shell command is enforced silently, while `status` reports PROTECTED and `doctor` passes every row.

This is not hypothetical. It happened on the author's machine: an agent was refused a `Write` to the policy file, twice, both refusals recorded as incidents — and then made the same edit from Bash with `sed -i`. A directory came out of `forbidden_paths`, two went into `allowed_paths`, 18 blocks that had really happened would no longer have happened, and every surface stayed green for ten days.

**Preventing that write is not achievable from a hook**, and pretending otherwise would be the same accidental coverage as the escape above. Noticing it is achievable, so that is what 0.1.2 does.

The policy is **sealed** at `usewarden init` — a verbatim copy, not a hash, because a hash tells you something changed and cannot tell you what stopped being caught. `status`, `doctor`, the status line and the new `usewarden policy --drift` compare **verdicts, not text**: both rulesets are replayed against a probe set derived from them and against your own recorded incidents.

```
usewarden policy --drift
usewarden reseal          # accept a change you made on purpose
```

A policy made **stricter** raises nothing. A guardian that shouts at every edit is a guardian people switch off, and this project has its own record of that happening.

Three findings are kept apart rather than blended:

- real blocks on your machine that would no longer happen,
- installed protections that no longer fire,
- protections **downgraded** from absolute (`forbidden_paths`, which holds everywhere) to conditional (`allowed_paths`, which holds only while you are standing in the right project).

The third is the one a block-count misses entirely, and it was the largest part of the incident above.

---

## Also in 0.1.2

- `usewarden replay` is documented. It shipped and was never listed.
- The README says plainly that the policy file is writable from the shell, that this happened, and that detection rather than prevention is the honest answer a hook can give.
- The published repository's own `npm test` was broken in four ways that only a checkout of *this* repo could see — including the publication sanitiser silently rewriting test fixtures whose subject was the path shape it redacts. All found by building and testing the tree being pushed rather than the tree the checkout was standing in.

## Verifying it yourself

0.1.2 carries [SLSA provenance](https://www.npmjs.com/package/usewarden#provenance) built by `.github/workflows/release.yml` from `main`. The workflow cannot publish — it can only stage; approval happens on npmjs.com with a hardware key, and the trusted publisher is configured `--allow-stage-publish` only, so the registry refuses a direct publish even from a workflow rewritten to attempt one.

```
npm audit signatures
```

Full detail in [`CHANGELOG.md`](https://github.com/djayamah/usewarden/blob/main/CHANGELOG.md).
