/** Core, agent-agnostic types. Nothing in here may import an adapter. */

export type AgentId = 'claude' | 'cursor' | 'gemini' | 'copilot' | 'codex' | 'opencode';

export const AGENT_IDS: readonly AgentId[] = [
  'claude', 'cursor', 'gemini', 'copilot', 'codex', 'opencode',
];

/** Normalized lifecycle events. Every adapter maps its vendor event onto one of these. */
export type EventKind =
  | 'session_start'
  | 'session_end'
  | 'user_prompt'
  | 'pre_tool'
  | 'post_tool'
  | 'pre_compact'
  | 'config_change';

/** Canonical tool names. Vendor tool ids are mapped in src/adapters/toolnames.ts. */
export type CanonicalTool =
  | 'bash' | 'read' | 'write' | 'edit' | 'glob' | 'grep' | 'web' | 'mcp' | 'task' | 'other';

export interface NormalizedEvent {
  /** Which agent produced this. */
  agent: AgentId;
  event: EventKind;
  /** Agent-provided session identifier; '' if the agent does not supply one. */
  sessionId: string;
  /** Resolved absolute cwd of the agent, or '' if unknown. */
  cwd: string;
  /** Canonical tool name for pre_tool/post_tool; undefined otherwise. */
  tool?: CanonicalTool;
  /** Vendor's own tool name, kept verbatim for incident cards. */
  rawTool?: string;
  /** The shell command, for tool === 'bash'. */
  command?: string;
  /** The file path the tool targets, for file tools. */
  filePath?: string;
  /** Free-form remaining tool input. NEVER interpolated into a shell string. */
  toolInput?: Record<string, unknown>;
  /** Path to the agent's transcript, if it supplies one. */
  transcriptPath?: string;
  /** User prompt text, for event === 'user_prompt'. */
  prompt?: string;
  /** Fraction 0..1 of the model context window in use, if the agent reports it. */
  contextFill?: number;
  /** Epoch ms. */
  ts: number;
}

export type Decision = 'allow' | 'deny' | 'ask';

export type Layer = 1 | 2;

export interface Verdict {
  decision: Decision;
  /** One line the agent can self-correct from. Shown to the human too. */
  reason: string;
  /** Which policy line fired, e.g. "commands.deny[2]" or "scope.forbidden_paths[0]". */
  rule?: string;
  layer: Layer;
  /** Additional non-blocking guidance surfaced to the agent. */
  advice?: string;
  severity: 'info' | 'warn' | 'block';
}

export const ALLOW: Verdict = { decision: 'allow', reason: '', layer: 1, severity: 'info' };

export interface Incident {
  id?: number;
  sessionId: string;
  agent: AgentId;
  ts: number;
  layer: Layer;
  severity: 'info' | 'warn' | 'block';
  /** What usewarden did about it. */
  action: 'block' | 'warn' | 'checkpoint' | 'compact-advice';
  /** Policy line that fired. */
  rule: string;
  /** Short headline for the incident card. */
  title: string;
  /** The action the agent attempted, rendered for a human. */
  attempted: string;
  /** Why usewarden objected. */
  reason: string;
  tool: string;
  target: string;
  cwd: string;
}

/** Integrity record: a hash of something usewarden owns and must detect changes to. */
export interface IntegrityRecord {
  id: string;
  kind: 'hook-entry' | 'policy';
  path: string;
  hash: string;
  recordedAt: number;
}

export type ProtectionState = 'PROTECTED' | 'UNPROTECTED' | 'TAMPERED' | 'POLICY_INVALID';
