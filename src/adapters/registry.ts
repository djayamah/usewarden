import type { AgentId } from '../types.js';
import type { Adapter } from './index.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter, copilotAdapter, cursorAdapter, geminiAdapter, openCodeAdapter } from './others.js';

/**
 * Adapter registry. All six agents are registered. An unknown agent id would get a pass-through
 * adapter that parses nothing and blocks nothing - failing open rather than pretending to
 * protect, which is the same posture as every other unavailable component in usewarden.
 */
const registry = new Map<AgentId, Adapter>([
  ['claude', claudeAdapter],
  ['gemini', geminiAdapter],
  ['cursor', cursorAdapter],
  ['copilot', copilotAdapter],
  ['codex', codexAdapter],
  ['opencode', openCodeAdapter],
]);

export function registerAdapter(a: Adapter): void { registry.set(a.id, a); }

export function getAdapter(id: AgentId): Adapter {
  const a = registry.get(id);
  if (a) return a;
  return {
    id,
    label: id,
    parse: () => null,
    render: () => ({ stdout: '', stderr: '', exitCode: 0 }),
  };
}

export function registeredAgents(): AgentId[] { return [...registry.keys()]; }
