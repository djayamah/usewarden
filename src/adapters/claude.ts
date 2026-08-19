import type { EventKind, NormalizedEvent, Verdict } from '../types.js';
import { asObject, normalizeCommon, str, type Adapter, type RenderedVerdict } from './index.js';

/**
 * Claude Code adapter.
 * Contract source: https://code.claude.com/docs/en/hooks (fetched 2026-08-19, HOOK-MATRIX.md).
 */

const EVENT_MAP: Record<string, EventKind> = {
  PreToolUse: 'pre_tool',
  PostToolUse: 'post_tool',
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  UserPromptSubmit: 'user_prompt',
  PreCompact: 'pre_compact',
  ConfigChange: 'config_change',
};

export const claudeAdapter: Adapter = {
  id: 'claude',
  label: 'Claude Code',

  parse(raw: unknown): NormalizedEvent | null {
    const o = asObject(raw);
    const name = str(o, 'hook_event_name');
    if (!name) return null;
    const kind = EVENT_MAP[name];
    if (!kind) return null;
    return normalizeCommon('claude', kind, o);
  },

  render(v: Verdict, e: NormalizedEvent): RenderedVerdict {
    // PreToolUse is the only blocking surface usewarden uses. Everything else is advisory, and
    // advisory output must not carry a permissionDecision or Claude Code will ignore the doc.
    if (e.event === 'pre_tool') {
      if (v.decision === 'deny') {
        return {
          stdout: JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: v.reason,
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (v.severity === 'warn') {
        return {
          stdout: JSON.stringify({
            systemMessage: v.reason,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow',
              permissionDecisionReason: v.reason,
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    if (v.severity !== 'info' && v.reason !== '') {
      return { stdout: JSON.stringify({ systemMessage: v.reason }), stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  },
};

/**
 * The hook entries usewarden registers in a Claude Code settings file.
 * `command` is filled in by the installer with an ABSOLUTE path to usewarden's own binary and a
 * FIXED argv - never a shell string, never anything derived from event data (THREAT-MODEL T-04).
 */
export function claudeHookEntries(usewardenBin: string): Record<string, unknown> {
  const cmd = (kind: string) => ({
    type: 'command',
    command: usewardenBin,
    args: ['hook', 'claude', kind],
    timeout: 10,
    statusMessage: 'usewarden',
  });
  return {
    PreToolUse: [{ matcher: '*', hooks: [cmd('pre_tool')] }],
    PostToolUse: [{ matcher: '*', hooks: [cmd('post_tool')] }],
    SessionStart: [{ matcher: '*', hooks: [cmd('session_start')] }],
    SessionEnd: [{ hooks: [cmd('session_end')] }],
    UserPromptSubmit: [{ hooks: [cmd('user_prompt')] }],
    PreCompact: [{ hooks: [cmd('pre_compact')] }],
    ConfigChange: [{ matcher: '*', hooks: [cmd('config_change')] }],
  };
}
