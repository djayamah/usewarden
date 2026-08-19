import type { EventKind, NormalizedEvent, Verdict } from '../types.js';
import { asObject, normalizeCommon, obj, str, type Adapter, type RenderedVerdict } from './index.js';
import { canonicalTool } from './toolnames.js';

/**
 * The five non-Claude adapters.
 *
 * Every vendor's contract is recorded in docs/HOOK-MATRIX.md with its source URL and a
 * 2026-08-19 fetch date. The five deny dialects are mutually incompatible, which is exactly why
 * they live here and never in the engine:
 *
 *   Gemini CLI   {"decision":"deny","reason":...}                      + stdout MUST be pure JSON
 *   Cursor       {"permission":"deny","user_message":...,"agent_message":...}
 *   Copilot CLI  {"permissionDecision":"deny","permissionDecisionReason":...}  (camelCase input!)
 *   Codex CLI    {"hookSpecificOutput":{...,"permissionDecision":"deny",...}}
 *   OpenCode     the plugin THROWS; usewarden hands it a Claude-shaped document to throw from
 */

// ---------------------------------------------------------------------------
// Gemini CLI
// ---------------------------------------------------------------------------

const GEMINI_EVENTS: Record<string, EventKind> = {
  BeforeTool: 'pre_tool',
  AfterTool: 'post_tool',
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  PreCompress: 'pre_compact',
};

export const geminiAdapter: Adapter = {
  id: 'gemini',
  label: 'Gemini CLI',

  parse(raw: unknown): NormalizedEvent | null {
    const o = asObject(raw);
    const name = str(o, 'hook_event_name');
    if (!name) return null;
    const kind = GEMINI_EVENTS[name];
    if (!kind) return null;
    return normalizeCommon('gemini', kind, o);
  },

  /**
   * CRITICAL (docs/HOOK-MATRIX.md, THREAT-MODEL T-11): Gemini CLI documents that a hook printing
   * anything but JSON on stdout breaks parsing and the CLI DEFAULTS TO ALLOW.
   *
   * Measured against a live Gemini CLI: an EMPTY stdout also counts as a parse failure - the CLI
   * reported "0 succeeded, 1 failed" for every event where usewarden stayed silent, even with exit
   * code 0 and clean stderr. So this adapter always writes exactly one JSON document, using `{}`
   * (a valid document carrying no decision) where the other adapters write nothing.
   */
  render(v: Verdict, e: NormalizedEvent): RenderedVerdict {
    const doc = (o: Record<string, unknown>): RenderedVerdict =>
      ({ stdout: JSON.stringify(o), stderr: '', exitCode: 0 });

    if (e.event !== 'pre_tool') {
      return v.severity !== 'info' && v.reason !== ''
        ? doc({ systemMessage: v.reason, continue: true })
        : doc({});
    }
    if (v.decision === 'deny') return doc({ decision: 'deny', reason: v.reason, continue: true });
    if (v.severity === 'warn') return doc({ systemMessage: v.reason, continue: true });
    return doc({});
  },
};

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

const CURSOR_EVENTS: Record<string, EventKind> = {
  beforeShellExecution: 'pre_tool',
  beforeReadFile: 'pre_tool',
  preToolUse: 'pre_tool',
  postToolUse: 'post_tool',
  sessionStart: 'session_start',
  sessionEnd: 'session_end',
  beforeSubmitPrompt: 'user_prompt',
  preCompact: 'pre_compact',
};

export const cursorAdapter: Adapter = {
  id: 'cursor',
  label: 'Cursor',

  parse(raw: unknown, argv: string[]): NormalizedEvent | null {
    const o = asObject(raw);
    const name = str(o, 'hook_event_name');
    // Cursor's beforeShellExecution/beforeReadFile payloads are flat, not tool-shaped, so the
    // event has to be recovered from the payload or, failing that, from usewarden's own argv.
    const kind = (name && CURSOR_EVENTS[name])
      ?? (argv[1] && CURSOR_EVENTS[argv[1]])
      ?? (typeof o['command'] === 'string' ? 'pre_tool' : undefined);
    if (!kind) return null;

    const ev: NormalizedEvent = {
      agent: 'cursor',
      event: kind,
      sessionId: str(o, 'conversation_id', 'session_id') ?? 'unknown',
      cwd: str(o, 'cwd') ?? firstWorkspaceRoot(o) ?? process.cwd(),
      ts: Date.now(),
    };
    const tp = str(o, 'transcript_path');
    if (tp) ev.transcriptPath = tp;

    const command = str(o, 'command');
    if (command) { ev.tool = 'bash'; ev.rawTool = 'shell'; ev.command = command; }

    const filePath = str(o, 'file_path');
    if (filePath) {
      ev.filePath = filePath;
      // beforeReadFile is a read; afterFileEdit and the generic tool events are not.
      if (!command) { ev.tool = name === 'beforeReadFile' ? 'read' : 'edit'; ev.rawTool = name ?? 'file'; }
    }

    const toolName = str(o, 'tool_name');
    if (toolName && !command) {
      ev.rawTool = toolName;
      ev.tool = canonicalTool('cursor', toolName);
      const input = obj(o, 'tool_input', 'arguments');
      if (input) ev.toolInput = input;
    }

    const prompt = str(o, 'prompt', 'text');
    if (prompt) ev.prompt = prompt;
    return ev;
  },

  render(v: Verdict, e: NormalizedEvent): RenderedVerdict {
    if (e.event !== 'pre_tool') return { stdout: '', stderr: '', exitCode: 0 };
    if (v.decision === 'deny') {
      return {
        stdout: JSON.stringify({
          permission: 'deny',
          user_message: v.reason,
          agent_message: v.reason,
        }),
        stderr: '', exitCode: 0,
      };
    }
    if (v.severity === 'warn') {
      return {
        stdout: JSON.stringify({ permission: 'allow', user_message: v.reason, agent_message: v.reason }),
        stderr: '', exitCode: 0,
      };
    }
    return { stdout: JSON.stringify({ permission: 'allow' }), stderr: '', exitCode: 0 };
  },
};

function firstWorkspaceRoot(o: Record<string, unknown>): string | undefined {
  const roots = o['workspace_roots'];
  if (Array.isArray(roots) && typeof roots[0] === 'string') return roots[0];
  return undefined;
}

// ---------------------------------------------------------------------------
// GitHub Copilot CLI
// ---------------------------------------------------------------------------

const COPILOT_EVENTS: Record<string, EventKind> = {
  preToolUse: 'pre_tool', PreToolUse: 'pre_tool',
  postToolUse: 'post_tool', PostToolUse: 'post_tool',
  sessionStart: 'session_start', SessionStart: 'session_start',
  sessionEnd: 'session_end', SessionEnd: 'session_end',
  userPromptSubmitted: 'user_prompt', UserPromptSubmitted: 'user_prompt',
  preCompact: 'pre_compact', PreCompact: 'pre_compact',
};

export const copilotAdapter: Adapter = {
  id: 'copilot',
  label: 'GitHub Copilot CLI',

  parse(raw: unknown, argv: string[]): NormalizedEvent | null {
    const o = asObject(raw);
    // Copilot is the only vendor whose payload is camelCase (HOOK-MATRIX), and it does not
    // always echo the event name, so usewarden's own argv is the fallback.
    const name = str(o, 'hookEventName', 'hook_event_name');
    const kind = (name && COPILOT_EVENTS[name]) ?? argvKind(argv[1]);
    if (!kind) return null;

    const ev: NormalizedEvent = {
      agent: 'copilot',
      event: kind,
      sessionId: str(o, 'sessionId', 'session_id') ?? 'unknown',
      cwd: str(o, 'cwd') ?? process.cwd(),
      ts: Date.now(),
    };
    const toolName = str(o, 'toolName', 'tool_name');
    if (toolName) { ev.rawTool = toolName; ev.tool = canonicalTool('copilot', toolName); }
    const args = obj(o, 'toolArgs', 'tool_input', 'arguments');
    if (args) {
      ev.toolInput = args;
      const cmd = args['command'] ?? args['cmd'];
      if (typeof cmd === 'string') ev.command = cmd;
      const fp = args['path'] ?? args['file_path'] ?? args['filePath'];
      if (typeof fp === 'string') ev.filePath = fp;
    }
    const prompt = str(o, 'prompt', 'userPrompt');
    if (prompt) ev.prompt = prompt;
    return ev;
  },

  render(v: Verdict, e: NormalizedEvent): RenderedVerdict {
    if (e.event !== 'pre_tool') return { stdout: '', stderr: '', exitCode: 0 };
    if (v.decision === 'deny') {
      return {
        stdout: JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: v.reason }),
        stderr: '', exitCode: 0,
      };
    }
    if (v.severity === 'warn') {
      return {
        stdout: JSON.stringify({ permissionDecision: 'allow', permissionDecisionReason: v.reason }),
        stderr: '', exitCode: 0,
      };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  },
};

// ---------------------------------------------------------------------------
// Codex CLI
// ---------------------------------------------------------------------------

const CODEX_EVENTS: Record<string, EventKind> = {
  PreToolUse: 'pre_tool',
  PostToolUse: 'post_tool',
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  UserPromptSubmit: 'user_prompt',
  PreCompact: 'pre_compact',
};

export const codexAdapter: Adapter = {
  id: 'codex',
  label: 'Codex CLI',

  parse(raw: unknown): NormalizedEvent | null {
    const o = asObject(raw);
    const name = str(o, 'hook_event_name');
    if (!name) return null;
    const kind = CODEX_EVENTS[name];
    if (!kind) return null;
    return normalizeCommon('codex', kind, o);
  },

  render(v: Verdict, e: NormalizedEvent): RenderedVerdict {
    if (e.event !== 'pre_tool') {
      return v.severity !== 'info' && v.reason !== ''
        ? { stdout: JSON.stringify({ systemMessage: v.reason }), stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 0 };
    }
    // Codex documents both a modern and a legacy shape. Usewarden emits the modern one only:
    // sending both would be ambiguous, and the legacy `decision` key is what an older Codex
    // would read anyway if it ignored `hookSpecificOutput`.
    if (v.decision === 'deny') {
      return {
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: v.reason,
          },
        }),
        stderr: '', exitCode: 0,
      };
    }
    if (v.severity === 'warn') {
      return {
        stdout: JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: v.reason },
        }),
        stderr: '', exitCode: 0,
      };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  },
};

// ---------------------------------------------------------------------------
// OpenCode
// ---------------------------------------------------------------------------

export const openCodeAdapter: Adapter = {
  id: 'opencode',
  label: 'OpenCode',

  parse(raw: unknown, argv: string[]): NormalizedEvent | null {
    const o = asObject(raw);
    // OpenCode has no vendor event vocabulary of its own on the wire; usewarden's generated plugin
    // supplies the kind in argv. An unrecognised kind is NOT guessed at - a guardian that
    // invents an event type will eventually evaluate the wrong policy against it.
    const kind = argvKind(argv[1]);
    if (!kind) return null;
    const ev: NormalizedEvent = {
      agent: 'opencode',
      event: kind,
      sessionId: str(o, 'session_id', 'sessionID') ?? 'unknown',
      cwd: str(o, 'cwd') ?? process.cwd(),
      ts: Date.now(),
    };
    const toolName = str(o, 'tool_name', 'tool');
    if (toolName) { ev.rawTool = toolName; ev.tool = canonicalTool('opencode', toolName); }
    const input = obj(o, 'tool_input', 'args');
    if (input) {
      ev.toolInput = input;
      const cmd = input['command'];
      if (typeof cmd === 'string') ev.command = cmd;
      const fp = input['filePath'] ?? input['file_path'] ?? input['path'];
      if (typeof fp === 'string') ev.filePath = fp;
    }
    return ev;
  },

  /**
   * OpenCode blocks by THROWING inside the plugin. Usewarden's generated plugin reads a
   * Claude-shaped document and throws the reason, so the shape here matches what
   * `openCodePlugin()` in src/install/entries.ts parses.
   */
  render(v: Verdict, e: NormalizedEvent): RenderedVerdict {
    if (e.event !== 'pre_tool' || v.decision !== 'deny') {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: v.reason,
        },
      }),
      stderr: '', exitCode: 0,
    };
  },
};

function argvKind(s: string | undefined): EventKind | undefined {
  const kinds: EventKind[] = ['session_start', 'session_end', 'user_prompt', 'pre_tool', 'post_tool', 'pre_compact', 'config_change'];
  return s && (kinds as string[]).includes(s) ? s as EventKind : undefined;
}
