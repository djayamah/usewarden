import type { AgentId, NormalizedEvent, Verdict } from '../types.js';
import { canonicalTool, extractCommand, extractPath } from './toolnames.js';

/**
 * An adapter is exactly two pure functions plus a registration descriptor.
 * Keeping verdict rendering here means the five mutually incompatible deny dialects
 * (see docs/HOOK-MATRIX.md) never leak into the engine.
 */
export interface Adapter {
  id: AgentId;
  /** Human name for status output. */
  label: string;
  /** Parse the vendor's stdin payload into usewarden's normalized event. */
  parse(raw: unknown, argv: string[]): NormalizedEvent | null;
  /** Render a verdict in the vendor's own protocol. */
  render(v: Verdict, e: NormalizedEvent): RenderedVerdict;
}

export interface RenderedVerdict {
  /** Exactly one JSON document, or '' when the vendor wants silence. */
  stdout: string;
  /** Diagnostics only. Never used to carry the decision unless `exitCode` is 2. */
  stderr: string;
  exitCode: 0 | 1 | 2;
}

type Raw = Record<string, unknown>;

export function asObject(raw: unknown): Raw {
  return (typeof raw === 'object' && raw !== null) ? raw as Raw : {};
}

export function str(o: Raw, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v !== '') return v;
  }
  return undefined;
}

export function obj(o: Raw, ...keys: string[]): Record<string, unknown> | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Shared normalization for the four agents whose payloads are structurally the same
 * (Claude Code, Codex, Gemini, Copilot). Differences are expressed as key aliases.
 */
export function normalizeCommon(
  agent: AgentId,
  event: NormalizedEvent['event'],
  o: Raw,
): NormalizedEvent {
  const toolInput = obj(o, 'tool_input', 'toolArgs', 'toolInput', 'arguments') ?? {};
  const rawTool = str(o, 'tool_name', 'toolName', 'tool');
  const ev: NormalizedEvent = {
    agent,
    event,
    sessionId: str(o, 'session_id', 'sessionId', 'conversation_id') ?? 'unknown',
    cwd: str(o, 'cwd', 'workingDirectory') ?? process.cwd(),
    ts: Date.now(),
  };
  if (rawTool) { ev.rawTool = rawTool; ev.tool = canonicalTool(agent, rawTool); }
  const cmd = extractCommand(toolInput);
  if (cmd) ev.command = cmd;
  const fp = extractPath(toolInput);
  if (fp) ev.filePath = fp;
  if (Object.keys(toolInput).length) ev.toolInput = toolInput;
  const tp = str(o, 'transcript_path', 'transcriptPath');
  if (tp) ev.transcriptPath = tp;
  const prompt = str(o, 'prompt', 'user_prompt', 'userPrompt', 'message');
  if (prompt) ev.prompt = prompt;
  return ev;
}
