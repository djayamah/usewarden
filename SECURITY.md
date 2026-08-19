# Security Policy

Usewarden is a security-adjacent tool. It writes hook entries into agent configuration files — the
same mechanism as CVE-2025-59536 — and it ships on npm, the channel ChainDrop exploited on
4 August 2026. Its own attack surface is documented, mapped to mitigations, and mapped to the
tests that prove them, in **[docs/THREAT-MODEL.md](docs/THREAT-MODEL.md)**.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting on this repository
(*Security → Report a vulnerability*). That opens a private advisory thread visible only to the
maintainers and to you.

Please include:
- usewarden version (`usewarden --version`), Node version, and OS;
- which agent(s) were configured;
- what usewarden did, and what you expected it to do;
- a minimal reproduction if you have one — a `usewarden.yaml`, a hook payload, or a sequence of
  commands.

### What to expect

| | |
|---|---|
| Acknowledgement | within **3 working days** |
| Initial assessment (severity + whether it is in scope) | within **7 working days** |
| Fix or documented mitigation for a confirmed high-severity issue | target **30 days** |
| Public advisory | after a fix ships, or after 90 days, whichever is sooner — coordinated with you |

Credit in the advisory unless you prefer otherwise.

## In scope

- Any way to make usewarden **execute** something an attacker controls: a crafted file path, tool
  argument, session id, `usewarden.yaml`, or hook payload reaching a shell or an `eval`.
- Any way to make usewarden report **PROTECTED** while it is not actually enforcing — the silent
  failure this whole product exists to avoid.
- Any way for a repository-supplied `usewarden.yaml` to **widen** the user's policy, weaken a rule,
  disable the judge, or enable telemetry without an explicit `usewarden trust`.
- Any way to get a credential, file path, prompt, or file content out of usewarden — into the judge
  payload, the SQLite store, an incident card, the dashboard, or a telemetry payload.
- Any way to reach the dashboard without the per-run token, from another origin, or to make it
  mutate state.
- Any way to make `usewarden uninstall` or `usewarden restore-configs` fail to restore byte-identically,
  or to make usewarden write outside `~/.usewarden` and the agent configs it registered in.
- Any install-time code execution — a lifecycle script in usewarden or anywhere in its lockfile.

## Out of scope

These are **documented limitations, not vulnerabilities**. They are stated in the README under
"What usewarden cannot catch".

- Usewarden is not a sandbox. An agent doing something your policy does not name is not a usewarden
  bug; it is a policy gap. (A rule that is *documented as covering it* and does not is in scope.)
- The Layer-2 drift judge is sampled, fallible, and **fails open** by design. A missed semantic
  drift is not a vulnerability. A prompt injection that makes the judge produce a *verdict*
  usewarden then acts on **is**.
- Agent surfaces that do not fire hooks: Codex IDE/desktop wrappers, OpenCode SDK-driven
  sessions. Both are named in the README.
- Vulnerabilities in the agents themselves — report those to their vendors.

## Supported versions

Pre-1.0. Only the latest published version receives fixes.

## Usewarden's own supply chain

- **No install scripts.** No `preinstall`, `install`, `postinstall`, or `prepare`, in usewarden or
  anywhere in the committed lockfile. Enforced by a test that fails the build.
- **Zero runtime dependencies.** Two devDependencies, both script-free
  (`docs/DEPENDENCY-BUDGET.md`).
- **`min-release-age=7`** in `.npmrc`, so no version younger than a week is ever installed.
- **Trusted publishing via GitHub Actions OIDC.** There is no long-lived npm token to steal.
- **Branch protection on `main` with no admin bypass, and a `release` environment with a required
  human reviewer.** ChainDrop's amplification step was a direct push to `main` that let the
  project's own workflow sign the malware; a required PR breaks that chain.
- **Provenance is not authorisation.** ChainDrop's malicious versions carried valid SLSA
  provenance and Sigstore attestations. `launch/PUBLISH-CHECKLIST.md` therefore requires manual
  inspection of the packed tarball before every publish, and `scripts/pre-publish-check.sh`
  prints the full file list for exactly that purpose.
