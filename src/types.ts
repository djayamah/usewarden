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

/**
 * The same list as a value, because two places need to TEST a string against it: the hook
 * entrypoint, and the check that recognises a registered hook as usewarden's own. It was written
 * out by hand in `src/hook.ts` and would have been written out a second time here; a list that
 * exists twice drifts, and this project has the scars (D-124, D-141, and the four scripts that
 * each carried their own browser candidate list).
 */
export const EVENT_KINDS: readonly EventKind[] = [
  'session_start', 'session_end', 'user_prompt', 'pre_tool', 'post_tool', 'pre_compact',
  'config_change',
];

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

/**
 * Where an incident came from. This is the anti-inflation axis: every reported number is
 * computed per origin, so a `usewarden demo` run - or a fixture, or a test - can never move the
 * figure a user would screenshot. See docs/METRICS.md.
 *
 *   live     a real agent session, through the hook path. The only origin that counts.
 *   demo     `usewarden demo`. Real evaluation, synthetic events, no agent.
 *   fixture  test fixtures, the sabotage suite, anything hand-fed to the engine.
 */
export type IncidentOrigin = 'live' | 'demo' | 'fixture';

export const INCIDENT_ORIGINS: readonly IncidentOrigin[] = ['live', 'demo', 'fixture'];

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
  /** The action the agent attempted, rendered for a human. Lossy; display only. */
  attempted: string;
  /**
   * THE ACTION AS IT WAS, verbatim — the only field a replay may read.
   *
   * `attempted` is a DISPLAY rendering: `describeAttempt` collapses newlines to pilcrows so a
   * heredoc cannot tear an incident card apart, and truncates at 200 characters so a card fits a
   * terminal. Both are right for a card and fatal for a record. 62 of the 92 real blocks on this
   * machine hit that truncation, and the audit of 2026-08-26 (D-258) concluded the corpus could
   * not be replayed at all because of it.
   *
   * So the replay input is stored separately and is never truncated, never one-lined, and never
   * redacted at write. Redaction happens on READ, at every display path. Truncating at write is
   * what destroyed the record the first time; doing it again with a different function would
   * destroy it the same way. See DECISIONS D-277.
   */
  replayable?: ReplayableAction;
  /** Why usewarden objected. */
  reason: string;
  tool: string;
  target: string;
  cwd: string;
}

/**
 * Everything a replay needs to re-evaluate a stored incident against a different ruleset.
 *
 * It is a SUBSET of NormalizedEvent, not the whole thing, and the omissions are deliberate:
 * `transcriptPath` points at a file that will not exist later, and `toolInput` can carry
 * arbitrary vendor payload of unbounded size. What is here is what Layer 1 actually reads.
 */
export interface ReplayableAction {
  agent: AgentId;
  event: EventKind;
  tool?: CanonicalTool;
  rawTool?: string;
  /** The shell command EXACTLY as the agent sent it. Newlines intact. Never truncated. */
  command?: string;
  filePath?: string;
  cwd: string;
  /**
   * The repository root Layer 1 resolved for this event, if it found one.
   *
   * Captured rather than re-derived for the same reason as `branch`, and for one more: finding a
   * repo root means walking UP the directory tree from `cwd` looking for `.git`, which is
   * filesystem access against a path out of the stored corpus. Under replay's fence that is not
   * allowed to happen at all. See Layer1Context.filesystem.
   */
  repoRoot?: string;
  prompt?: string;
  contextFill?: number;
  /**
   * The git branch of `cwd` at the moment of the event.
   *
   * Captured rather than re-derived, because `force-push-protected` asks whether the CURRENT
   * branch is protected, and by replay time the branch has moved. A replay that re-read the
   * branch from disk would be measuring today's checkout, not the incident.
   */
  branch?: string;
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
