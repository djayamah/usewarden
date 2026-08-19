# HOOK MATRIX — live-fetched agent hook contracts

All rows fetched from primary vendor documentation on **2026-08-19**. Nothing here is from
memory; every row carries its source URL and fetch date. Where a claim could not be verified
against a primary source it is marked `UNVERIFIED`.

Local installation status measured on this build machine (`command -v`) on 2026-08-19.

| Agent | Installed here | Config path(s) | Registration shape | Pre-tool event | Block mechanism | Adapter status |
|---|---|---|---|---|---|---|
| Claude Code | **YES** (`/opt/homebrew/bin/claude`) | `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json` | `hooks.<Event>[] = {matcher, hooks:[{type:"command",command,timeout}]}` | `PreToolUse` | JSON `hookSpecificOutput.permissionDecision:"deny"` **or** exit 2 + stderr | VERIFIED-LOCALLY |
| Gemini CLI | **YES** (`/opt/homebrew/bin/gemini`) | `~/.gemini/settings.json`, `.gemini/settings.json` | `hooks.<Event>[] = {matcher, hooks:[{type:"command",command,timeout}]}` — **command STRING only, no `args` array; `timeout` is MILLISECONDS** | `BeforeTool` | JSON `{"decision":"deny","reason":...}` **or** exit 2 + stderr | PARTIALLY-VERIFIED-LIVE (hooks execute + events captured against a live CLI; tool-call path unauthenticated here) |
| Cursor | no | `.cursor/hooks.json`, `~/.cursor/hooks.json` | `{version:1, hooks:{eventName:[{command,type,timeout,matcher}]}}` | `beforeShellExecution`, `beforeReadFile`, `preToolUse` | JSON `{"permission":"deny", user_message, agent_message}` | UNVERIFIED-LOCALLY |
| GitHub Copilot CLI | no | `~/.copilot/hooks/*.json`, `.github/hooks/*.json`, inline in `~/.copilot/settings.json` | `{version:1, hooks:{preToolUse:[{type:"command",...}]}}` | `preToolUse` | JSON `permissionDecision:"deny"` + `permissionDecisionReason` | UNVERIFIED-LOCALLY |
| Codex CLI | no (`~/.codex/` dir exists, no binary) | `~/.codex/hooks.json`, `~/.codex/config.toml`, `<repo>/.codex/{hooks.json,config.toml}` | JSON same shape as Claude Code, **or** TOML `[[hooks.PreToolUse]]` + `[[hooks.PreToolUse.hooks]]` | `PreToolUse` | modern `hookSpecificOutput.permissionDecision:"deny"`, legacy `{"decision":"block","reason":...}`, or exit 2 | UNVERIFIED-LOCALLY |
| OpenCode | no | `~/.config/opencode/`, plugin TS modules | TypeScript plugin exporting `tool.execute.before` | `tool.execute.before` | **throw** from the hook function | UNVERIFIED-LOCALLY, BEST-EFFORT |

---

## Claude Code
Source: <https://code.claude.com/docs/en/hooks> and <https://code.claude.com/docs/en/settings> — fetched 2026-08-19.

**Events (subset usewarden uses):** `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, `PreCompact`, `PostCompact`, `Stop`, `ConfigChange`.
Full event list also includes `Setup`, `StopFailure`, `PostToolUseFailure`, `PermissionRequest`,
`PermissionDenied`, `PostToolBatch`, `UserPromptExpansion`, `SubagentStart`, `SubagentStop`,
`TaskCreated`, `TaskCompleted`, `TeammateIdle`, `InstructionsLoaded`, `CwdChanged`,
`DirectoryAdded`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `Elicitation`,
`ElicitationResult`, `Notification`, `MessageDisplay`.

**PreToolUse stdin:**
```json
{ "session_id","prompt_id","transcript_path","cwd","permission_mode","hook_event_name",
  "tool_name","tool_input":{...},"tool_use_id" }
```

**Blocking (JSON on stdout, exit 0):**
```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse",
  "permissionDecision":"deny","permissionDecisionReason":"..."}}
```
`permissionDecision` ∈ `allow | deny | ask`.

**Exit codes:** `0` success (stdout parsed as JSON for a decision); `1` non-blocking error;
`2` blocking error — action denied on blocking events, stderr surfaced.

**Settings precedence (highest first):** managed policy → CLI args → `.claude/settings.local.json`
→ `.claude/settings.json` → `~/.claude/settings.json`.

**Matcher syntax:** `"*"`/`""`/omitted = all; a string of only `[a-zA-Z0-9_\- ,|]` = exact or
`|`-separated list; anything else = unanchored JS regex. MCP tools are named
`mcp__<server>__<tool>`.

**Caveats usewarden must respect:**
- `disableAllHooks: true` silently turns usewarden off. `usewarden status` must detect this and report
  UNPROTECTED (see THREAT-MODEL T-07).
- Hooks reload automatically on settings-file change, and `ConfigChange` fires — usewarden subscribes
  to `ConfigChange` for self-integrity.
- Timeouts default generously; usewarden sets an explicit short timeout so a usewarden bug can never
  wedge the user's agent.

## Gemini CLI
Source: <https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md> — fetched 2026-08-19.

**Events:** `BeforeTool`, `AfterTool`, `BeforeAgent`, `AfterAgent`, `BeforeModel`,
`BeforeToolSelection`, `AfterModel`, `SessionStart`, `SessionEnd`, `Notification`, `PreCompress`.

**BeforeTool stdin:**
```json
{ "session_id","transcript_path","cwd","hook_event_name","timestamp",
  "tool_name","tool_input","mcp_context","original_request_name" }
```

**Deny stdout:**
```json
{"decision":"deny","reason":"...","systemMessage":"...","suppressOutput":false,"continue":true}
```

**Exit codes:** `0` = stdout parsed as JSON; `2` = system block, stderr is the reason;
other = warning, CLI continues.

**CRITICAL CAVEAT — stdout purity.** "Your script must not print any plain text to stdout other
than the final JSON." Any stray byte breaks parsing and the CLI **defaults to Allow** — i.e. a
sloppy usewarden adapter silently disables protection. Usewarden's Gemini adapter therefore routes
every diagnostic to stderr and writes exactly one JSON document to stdout. Proven by
`tests/adapters.test.ts` → *gemini adapter emits nothing but one JSON document on stdout*.

Tool names are the built-in tool ids (`read_file`, `run_shell_command`, `write_file`, …), which
differ from Claude Code's (`Read`, `Bash`, `Write`) — the adapter normalizes.

## Cursor
Source: <https://cursor.com/docs/hooks> — fetched 2026-08-19. Hooks landed in Cursor 1.7.

**Events:** `sessionStart`, `sessionEnd`, `preToolUse`, `postToolUse`, `postToolUseFailure`,
`subagentStart`, `subagentStop`, `beforeShellExecution`, `afterShellExecution`,
`beforeMCPExecution`, `afterMCPExecution`, `beforeReadFile`, `afterFileEdit`,
`beforeSubmitPrompt`, `preCompact`, `stop`, `afterAgentResponse`, `afterAgentThought`,
plus tab hooks (`beforeTabFileRead`, `afterTabFileEdit`) and `workspaceOpen`.

**Config:** `{"version":1,"hooks":{"<event>":[{"command","type","timeout","loop_limit","failClosed","matcher"}]}}`
at `.cursor/hooks.json` (project) or `~/.cursor/hooks.json` (user). Enterprise:
`/Library/Application Support/Cursor/hooks.json` on macOS.

**beforeShellExecution stdin:** `command`, `cwd`, `sandbox`, `conversation_id`, `generation_id`,
`model`, `hook_event_name`, `cursor_version`, `workspace_roots[]`, `user_email`, `transcript_path`.
**stdout:** `{"permission":"allow"|"deny"|"ask","user_message"?,"agent_message"?}`.

**beforeReadFile stdin** adds `file_path`, `content`, `attachments[]`;
**stdout:** `{"permission":"allow"|"deny","user_message"?}` (no `ask`).

**Caveat — duplicate events.** Cursor documents loading hooks from third-party tools including
Claude Code, so a machine with both configured can deliver the same logical event twice. Usewarden
deduplicates by a content hash of `(agent-family, session, event, tool, normalized args, coarse
timestamp bucket)` rather than trusting the agent id. Proven by
`tests/dedupe.test.ts`.

Cursor's `failClosed` flag is the opposite of usewarden's default posture; usewarden registers with
`failClosed: false` so a usewarden crash cannot brick the user's agent (§3A.6, escape hatch).

## GitHub Copilot CLI
Source: <https://docs.github.com/en/copilot/reference/hooks-reference> — fetched 2026-08-19.

**Events:** `sessionStart`, `sessionEnd`, `userPromptSubmitted`, `userPromptTransformed`,
`preToolUse`, `postToolUse`, `postToolUseFailure`, `preCompact`, `agentStop`, `subagentStart`,
`subagentStop`, `permissionRequest`, `notification`, `errorOccurred`. PascalCase aliases accepted.

**Config:** `{"version":1,"disableAllHooks":false,"hooks":{"<event>":[{"type":"command",...}]}}`
in `~/.copilot/hooks/*.json` or `.github/hooks/*.json`, or inline under `hooks` in
`~/.copilot/settings.json`.

**preToolUse stdin (camelCase, unlike every other agent):**
`{ sessionId, timestamp, cwd, toolName, toolArgs }`.
**stdout:** `{ permissionDecision: "allow"|"deny"|"ask", permissionDecisionReason, modifiedArgs? }`.

Default timeout 30 s. Multiple `preToolUse` hooks run sequentially; any `deny` blocks.

## Codex CLI
Source: <https://learn.chatgpt.com/docs/hooks> (redirected from developers.openai.com/codex/hooks) — fetched 2026-08-19.
Hooks engine stable as of Codex v0.124.0 (2026-04-23).

**Layers (precedence order as documented):** `~/.codex/hooks.json`, `~/.codex/config.toml`,
`<repo>/.codex/hooks.json`, `<repo>/.codex/config.toml`.

**Events:** turn scope — `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`,
`PostCompact`, `UserPromptSubmit`, `SubagentStop`, `Stop`; session — `SessionStart`, `SessionEnd`;
subagent — `SubagentStart`, `SubagentStop`.

**TOML registration:**
```toml
[[hooks.PreToolUse]]
matcher = "^Bash$"
[[hooks.PreToolUse.hooks]]
type = "command"
command = '/abs/path/to/usewarden hook codex'
timeout = 30
```

**PreToolUse stdin:** `session_id`, `turn_id`, `cwd`, `hook_event_name`, `model`,
`permission_mode`, `tool_name`, `tool_use_id`, `tool_input`, `transcript_path`.
**Deny:** modern `hookSpecificOutput.permissionDecision:"deny"`; legacy `{"decision":"block","reason"}`;
or exit 2 + stderr. Usewarden emits the modern form.

**DOCUMENTED CAVEAT (must appear in README limitations):** project-local hooks load only when the
`.codex/` layer is trusted, and **IDE / desktop wrappers may ignore project configuration
entirely**. Usewarden therefore registers Codex hooks at the **user layer** (`~/.codex/hooks.json`),
not the project layer, and `usewarden status` states plainly that Codex coverage does not extend to
the desktop wrapper.

## OpenCode
Source: <https://opencode.ai/docs/plugins/>, <https://opencode.ai/docs/permissions/> — fetched 2026-08-19.

OpenCode has no JSON hook-registration file; extensibility is a TypeScript **plugin** exporting
lifecycle handlers, of which `tool.execute.before` is the pre-tool interception point. Blocking is
done by **throwing** from the handler rather than by returning a decision document.

**BEST-EFFORT status.** Usewarden ships an OpenCode plugin shim that shells out to the same
`usewarden hook` entrypoint and throws on a deny verdict, covered by a contract test only. It is
marked `UNVERIFIED-LOCALLY`.

**Known upstream defect to document, not to work around:** explicit `deny` permissions in
`opencode.json` are reported ignored when the agent is invoked via the OpenCode SDK
(anomalyco/opencode issue #6396). Usewarden's interception is independent of that path, but the
README states that OpenCode SDK-driven sessions are not a coverage guarantee.

---

---

## CORRECTIONS FOUND BY RUNNING A LIVE AGENT (not by reading the docs)

Both of these produced a usewarden that reported **PROTECTED** while not a single hook completed.
They are the reason this project's verification rule is "fire it against a live agent", and both
now have a permanent home in the code with the measurement written next to them.

| # | What the docs implied | What a live agent actually did | Fix |
|---|---|---|---|
| L-1 | `timeout` is a duration; Claude Code documents seconds, so 10 is 10 seconds | Gemini CLI logged `Hook execution error: Hook timed out after 10ms` on **every** event. Its `timeout` is MILLISECONDS (the reference gives a default of `60000`). | `TIMEOUTS` table in `src/install/entries.ts` records the unit per vendor: Claude 10s, Codex 30s, Copilot 30s, Gemini 10000ms, Cursor omitted (unit undocumented — omitting takes the vendor default rather than guessing). |
| L-2 | A command hook takes `command` plus an `args` array | Only Claude Code documents `args`. Gemini CLI silently dropped it and executed a bare `node`, logging `0 succeeded, 1 failed` for every event. | `USES_ARGS_ARRAY` in `src/install/entries.ts`. Claude Code keeps the exec form (no shell); every other vendor gets one shell-quoted command STRING built solely from usewarden's own absolute paths. |
| L-3 | Empty stdout with exit 0 means "no opinion" | Gemini CLI counted an empty stdout as a hook FAILURE. | The Gemini adapter always writes exactly one JSON document, using `{}` where other adapters write nothing. |

After all three fixes, a live Gemini CLI reports
`Hook execution for SessionEnd: 1 hooks executed successfully` and usewarden's database contains
real `session_start` / `session_end` rows with `agent = 'gemini'`
(`verification/live/06-gemini-env.txt`).

**Gemini live coverage is partial and is stated as such.** This machine has no `GEMINI_API_KEY`
and no configured OAuth, so the CLI exits before making any model-driven tool call. Registration,
hook execution and event capture are proven live; the `BeforeTool` deny path is proven by the
contract tests and by a real `usewarden hook gemini pre_tool` subprocess, not by a live model.

---

## Layer 2 judge providers

Layer 1 is the same code for every agent. Layer 2 talks to a model, and which model depends on
what the machine has. Verification status per provider, using the same rule as the rest of this
matrix — a row only says "live" if something actually ran:

| Provider | Selected when | Contract-tested | Live |
|---|---|---|---|
| `local-claude` | `claude` is on PATH and authenticated | yes | **yes** — 12 sessions, 2 drift catches |
| `local-gemini` | `gemini` is on PATH and authenticated | yes | partial — no key on the build machine |
| `anthropic` | `ANTHROPIC_API_KEY` set | yes — `tests/judge-providers.test.ts` | **UNVERIFIED-LIVE** |
| `openai` | `OPENAI_API_KEY` set | yes — `tests/judge-providers.test.ts` | **UNVERIFIED-LIVE** |
| `gemini` | `GEMINI_API_KEY` set | yes — `tests/judge-providers.test.ts` | **UNVERIFIED-LIVE** |

Selection order is fixed: Anthropic, then OpenAI, then Gemini, then a local CLI. `usewarden
judge-check` makes one real call and prints which provider answered, what it cost, and whether
the ledger moved by the same amount. Procedure: `ops/JUDGE-LIVE-CHECK.md`.

---

## Normalization decisions

Usewarden's internal event is agent-agnostic:

```
NormalizedEvent {
  agent: 'claude'|'cursor'|'gemini'|'copilot'|'codex'|'opencode'
  event: 'pre_tool'|'post_tool'|'session_start'|'session_end'|'user_prompt'|'pre_compact'|'config_change'
  sessionId, cwd, toolName (canonical), toolInput, transcriptPath, raw
}
```

Canonical tool names: `bash`, `read`, `write`, `edit`, `glob`, `grep`, `web`, `mcp`, `other`.
Per-agent aliases live in `src/adapters/toolnames.ts` so a new agent is one table entry.

Verdict rendering is per-agent and lives in one function per adapter, so the three distinct deny
dialects (Claude/Codex `hookSpecificOutput`, Gemini `decision`, Cursor `permission`,
Copilot `permissionDecision`, OpenCode `throw`) never leak into the engine.
