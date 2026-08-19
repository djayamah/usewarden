# TELEMETRY

**Usewarden's telemetry is OFF by default, and v1 ships no endpoint at all.**

That is not a promise about intent; it is a property of the code. `endpoint()` in
`src/telemetry.ts` returns `null` unless *you* set `USEWARDEN_TELEMETRY_ENDPOINT` yourself, so with
a default install there is nowhere for a payload to go even if it were built. Turning telemetry
on writes a line to a local JSONL file under `~/.usewarden/telemetry/` and nothing else.

## Switching it on and off

```bash
usewarden telemetry status   # what is the setting, and what exactly would be sent
usewarden telemetry on       # opt in - prints the full payload so you can read it first
usewarden telemetry off      # opt out
```

Two environment variables force it off regardless of the setting, and both are honoured:

| Variable | Effect |
|---|---|
| `DO_NOT_TRACK=1` | telemetry off, overriding an explicit opt-in |
| `USEWARDEN_TELEMETRY=0` | telemetry off, overriding an explicit opt-in |

## The exact payload schema

This is the whole of it. There are no other fields, and
`tests/packaging.test.ts` fails the build if the code produces a field this document does not
describe.

```jsonc
{
  "v": 1,                    // schema version
  "usewarden": "0.1.0",         // usewarden's version
  "platform": "darwin",      // process.platform ONLY - no OS release, no arch, no hostname
  "node": "22",              // MAJOR version only
  "agents": ["claude"],      // which agent ids are registered. ids only, never config paths
  "counts": {
    "events_seen": 1420,     // whole numbers
    "actions_blocked": 6,
    "drift_caught": 3,
    "sessions": 11,
    "live_catches": 6
  },
  "rules": {                 // which of USEWARDEN'S OWN rule ids fired, and how often
    "dotenv-access": 4,
    "scope.allowed_paths": 2
  },
  "checklist": ["agents_detected", "policy_created"]  // coarse install-funnel state
}
```

## What is never in it

- No file path, of any kind. Not the repo, not the config, not `USEWARDEN_HOME`.
- No prompt, command, transcript, diff, or file content.
- No username, hostname, email, IP, machine id, or any stable per-machine identifier.
- No API key or token, and no field into which one could be pasted.
- No custom rule text. Only rule *ids*, and only ids that pass `isSafeLabel()`: at most 48
  characters of `[a-z0-9_.-]`, containing none of `/`, `\`, `@`, `sk-`, `ghp_`, `http`. A rule id
  you invented in your own `usewarden.yaml` that looks like a path is **dropped**, not sent.

## Why the transport is written the way it is

The documented failure mode of common analytics SDKs is retry-with-exponential-backoff, which
hangs a CLI on a firewalled, offline, or captive-portal network. Usewarden runs inside an agent's
hook path, where that would mean the user's agent appearing to freeze. So the send is:

- **2-second hard timeout** via `AbortController`.
- **Zero retries.** A failed send is discarded silently.
- **Fire and forget.** Nothing awaits the promise.
- **`unref`'d timer**, so a pending request can never hold the process open.
- **HTTPS only.** A `http://` endpoint is refused.

Asserted by `tests/packaging.test.ts` under "T-15: telemetry", and mapped in
`docs/THREAT-MODEL.md` T-15.

## Inspecting what usewarden has recorded

```bash
cat ~/.usewarden/telemetry/local.jsonl
```

Deleting that file is safe and usewarden will not recreate it unless telemetry is on.
