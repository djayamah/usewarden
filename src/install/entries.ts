import type { AgentId } from '../types.js';
import { nodePath } from './installer.js';

/**
 * The hook entries usewarden registers, per agent.
 *
 * THREAT-MODEL T-04 constraints that every builder in this file obeys:
 *   - `command` is the ABSOLUTE path to the Node binary, and argv[0] is the ABSOLUTE path to
 *     usewarden's own CLI script. Neither is ever resolved through PATH.
 *   - argv is FIXED (`hook <agent> <kind>`). No event data ever reaches it.
 *   - No `curl`, no shell pipeline, no dynamic string built from anything untrusted.
 *   - Every entry is tagged `"_usewarden": true` so usewarden can find and remove exactly its own
 *     entries later without touching a neighbour's.
 *
 * Event names and container shapes are per docs/HOOK-MATRIX.md (vendor docs, fetched 2026-08-19).
 */

export const USEWARDEN_TAG = '_usewarden';

export interface EntryPlan {
  /** Dotted path inside the config object where the hooks container lives. */
  containerPath: string[];
  /** eventName -> array of entries to add. */
  entries: Record<string, unknown[]>;
  /** Extra scalar keys the container needs (e.g. Cursor's `version: 1`). */
  containerDefaults?: Record<string, unknown>;
}

/**
 * Hook timeout, per vendor, IN THAT VENDOR'S OWN UNIT.
 *
 * This table exists because of a bug found only by a live session: usewarden registered
 * `timeout: 10` everywhere, and Gemini CLI reported `Hook timed out after 10ms` on every single
 * event - its timeout field is MILLISECONDS (docs give a default of 60000), while Claude Code's
 * and Codex's are SECONDS. Usewarden was installed, `usewarden status` said PROTECTED, and not one
 * hook ever completed. Exactly the silent-guardian failure section 3B names as the worst one.
 *
 * `undefined` means "omit the field and take the vendor's default". That is the correct choice
 * whenever the unit is not documented: guessing wrong in the small direction disables protection
 * silently, and guessing wrong in the large direction wedges the user's agent.
 */
const TIMEOUTS: Record<AgentId, number | undefined> = {
  claude: 10,       // seconds - code.claude.com/docs/en/hooks
  codex: 30,        // seconds - learn.chatgpt.com/docs/hooks TOML example
  copilot: 30,      // seconds - docs.github.com hooks reference ("default timeout 30 seconds")
  gemini: 10_000,   // MILLISECONDS - gemini-cli docs/hooks/reference.md (default 60000)
  cursor: undefined,   // unit not documented; take Cursor's own default
  opencode: undefined, // plugin shim, no registry field
};

/**
 * Which vendors document an `args` ARRAY on a command hook.
 *
 * Only Claude Code does ("optional; enables exec form"). This matters and was found live:
 * usewarden originally sent `{command: "<node>", args: ["<script>", "hook", ...]}` to Gemini CLI,
 * which has no `args` field in its schema, silently dropped it, and executed a bare `node` -
 * every event logged "0 succeeded, 1 failed" while `usewarden status` said PROTECTED.
 *
 * Everyone else therefore gets a single command STRING with the interpreter and script
 * shell-quoted. That string is still built only from usewarden's own absolute paths plus fixed
 * literals - no event data reaches it, so T-04 holds either way. The exec form is preferred
 * where it exists purely because it avoids a shell entirely.
 */
const USES_ARGS_ARRAY = new Set<AgentId>(['claude']);

function commandFields(agent: AgentId, bin: string, kind: string): Record<string, unknown> {
  if (USES_ARGS_ARRAY.has(agent)) {
    return { command: nodePath(), args: [bin, 'hook', agent, kind] };
  }
  return { command: `${shQuote(nodePath())} ${shQuote(bin)} hook ${agent} ${kind}` };
}

/** Claude Code, Codex CLI, Gemini CLI: same container shape, different event vocabularies. */
function claudeShaped(bin: string, agent: AgentId, events: Record<string, string>, matcherEvents: Set<string>): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const [vendorEvent, kind] of Object.entries(events)) {
    const hook: Record<string, unknown> = {
      type: 'command',
      ...commandFields(agent, bin, kind),
      ...(TIMEOUTS[agent] !== undefined ? { timeout: TIMEOUTS[agent] } : {}),
      [USEWARDEN_TAG]: true,
    };
    out[vendorEvent] = matcherEvents.has(vendorEvent)
      ? [{ matcher: '*', hooks: [hook], [USEWARDEN_TAG]: true }]
      : [{ hooks: [hook], [USEWARDEN_TAG]: true }];
  }
  return out;
}

export function planFor(agent: AgentId, bin: string): EntryPlan {
  switch (agent) {
    case 'claude':
      return {
        containerPath: ['hooks'],
        entries: claudeShaped(bin, 'claude', {
          PreToolUse: 'pre_tool',
          PostToolUse: 'post_tool',
          SessionStart: 'session_start',
          SessionEnd: 'session_end',
          UserPromptSubmit: 'user_prompt',
          PreCompact: 'pre_compact',
          ConfigChange: 'config_change',
        }, new Set(['PreToolUse', 'PostToolUse', 'SessionStart', 'ConfigChange'])),
      };

    case 'codex':
      return {
        containerPath: ['hooks'],
        entries: claudeShaped(bin, 'codex', {
          PreToolUse: 'pre_tool',
          PostToolUse: 'post_tool',
          SessionStart: 'session_start',
          SessionEnd: 'session_end',
          UserPromptSubmit: 'user_prompt',
          PreCompact: 'pre_compact',
        }, new Set(['PreToolUse', 'PostToolUse'])),
      };

    case 'gemini':
      // Gemini CLI event vocabulary differs: BeforeTool/AfterTool/PreCompress.
      return {
        containerPath: ['hooks'],
        entries: claudeShaped(bin, 'gemini', {
          BeforeTool: 'pre_tool',
          AfterTool: 'post_tool',
          SessionStart: 'session_start',
          SessionEnd: 'session_end',
          PreCompress: 'pre_compact',
        }, new Set(['BeforeTool', 'AfterTool'])),
      };

    case 'cursor': {
      // Cursor's schema takes a single `command` STRING with no args array, so the argv is
      // embedded. The string is built only from usewarden's own absolute path plus fixed literals -
      // no event data, no user input - and the path is shell-quoted.
      const mk = (kind: string) => ({
        type: 'command',
        ...commandFields('cursor', bin, kind),
        // No `timeout`: Cursor does not document the unit, and a wrong guess either disables
        // protection silently or wedges the agent. See the TIMEOUTS table above.
        // Fail OPEN: a usewarden crash must never brick the user's agent (DECISIONS D-006).
        failClosed: false,
        [USEWARDEN_TAG]: true,
      });
      return {
        containerPath: ['hooks'],
        containerDefaults: { version: 1 },
        entries: {
          beforeShellExecution: [mk('pre_tool')],
          beforeReadFile: [mk('pre_tool')],
          preToolUse: [mk('pre_tool')],
          postToolUse: [mk('post_tool')],
          sessionStart: [mk('session_start')],
          sessionEnd: [mk('session_end')],
          beforeSubmitPrompt: [mk('user_prompt')],
          preCompact: [mk('pre_compact')],
        },
      };
    }

    case 'copilot': {
      const mk = (kind: string) => ({
        type: 'command',
        ...commandFields('copilot', bin, kind),
        timeout: TIMEOUTS.copilot,
        [USEWARDEN_TAG]: true,
      });
      return {
        containerPath: ['hooks'],
        containerDefaults: { version: 1 },
        entries: {
          preToolUse: [mk('pre_tool')],
          postToolUse: [mk('post_tool')],
          sessionStart: [mk('session_start')],
          sessionEnd: [mk('session_end')],
          userPromptSubmitted: [mk('user_prompt')],
          preCompact: [mk('pre_compact')],
        },
      };
    }

    case 'opencode':
      // OpenCode has no JSON hook registry; the plugin file is written whole, so there is no
      // container to merge into. See openCodePlugin() below.
      return { containerPath: [], entries: {} };
  }
}

/** Shell-quotes a path for a vendor that only accepts a command STRING. */
export function shQuote(s: string): string {
  return `'` + s.replace(/'/g, `'\\''`) + `'`;
}

/**
 * OpenCode plugin shim. The whole file is usewarden's, so `usewarden uninstall` deletes it rather
 * than editing it. It shells out to the same `usewarden hook` entrypoint with a fixed argv and
 * throws on a deny verdict, which is OpenCode's documented blocking mechanism.
 */
export function openCodePlugin(bin: string): string {
  return `// Generated by usewarden. Do not edit; \`usewarden init\` overwrites this file.
// OpenCode blocks a tool call by THROWING from tool.execute.before (opencode.ai/docs/plugins).
// Usewarden invokes its own binary with a fixed argv - no shell, no event data in the command.
import { execFileSync } from 'node:child_process';

const USEWARDEN_NODE = ${JSON.stringify(nodePath())};
const USEWARDEN_BIN = ${JSON.stringify(bin)};

function ask(kind, payload) {
  try {
    const out = execFileSync(USEWARDEN_NODE, [USEWARDEN_BIN, 'hook', 'opencode', kind], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return out.trim() ? JSON.parse(out) : null;
  } catch {
    return null; // fail OPEN - usewarden must never brick the agent
  }
}

export const usewarden = async () => ({
  'tool.execute.before': async (input, output) => {
    const v = ask('pre_tool', {
      hook_event_name: 'tool.execute.before',
      agent: 'opencode',
      tool_name: input?.tool,
      tool_input: output?.args ?? {},
      session_id: input?.sessionID ?? 'unknown',
      cwd: process.cwd(),
    });
    const d = v?.hookSpecificOutput?.permissionDecision;
    if (d === 'deny') throw new Error(v.hookSpecificOutput.permissionDecisionReason);
  },
});
`;
}
