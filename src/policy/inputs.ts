import type { NormalizedEvent } from '../types.js';

/**
 * WHICH EVENT FIELD EACH POLICY RULE ACTUALLY READS — and which fields any agent ever sends.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS FILE EXISTS: A RULE THAT CANNOT FIRE IS WORSE THAN A RULE THAT IS ABSENT
 * ---------------------------------------------------------------------------------------------
 * `context.warn_pct` shipped in the default policy, printed in `usewarden policy`, and was covered
 * by a passing unit test — while being structurally incapable of firing, because no adapter has
 * ever populated `contextFill`. The test passed because the TEST supplied the field the PRODUCT
 * never does. A user reading their own policy saw a protection they did not have (D-224).
 *
 * The instance is cheap to fix. The CLASS is what needs a control, because nothing stopped the
 * next rule from being added the same way. So:
 *
 *   - `POLICY_INPUTS` declares, per policy section, which `NormalizedEvent` fields it reads.
 *   - `ADAPTER_POPULATED_FIELDS` declares which fields the adapters actually set.
 *   - `tests/policy-inputs.test.ts` proves the second declaration true by scanning the adapters,
 *     then enumerates every ACTIVE element of the default policy and fails if any of them depends
 *     on a field outside that set.
 *
 * The declarations live here rather than being derived at runtime because a packaged install has
 * no `src/` to scan. The test is what keeps the declaration honest; the runtime just reads it.
 */

export type EventField = keyof NormalizedEvent;

/**
 * Every field `normalizeCommon` (and the per-agent adapters) actually assign.
 *
 * `tests/policy-inputs.test.ts` derives this same set by static scan and asserts equality, so an
 * adapter that starts or stops populating a field fails the suite rather than silently changing
 * which rules can fire.
 */
export const ADAPTER_POPULATED_FIELDS: readonly EventField[] = [
  'agent', 'event', 'sessionId', 'cwd', 'ts',
  'tool', 'rawTool', 'command', 'filePath', 'toolInput', 'transcriptPath', 'prompt',
];

/**
 * NOT populated by anything, and named so the reason survives.
 *
 * `contextFill` — no agent sends it. Claude Code's hook payload is the best documented of the six
 * and carries `session_id`, `prompt_id`, `transcript_path`, `cwd`, `permission_mode`, `effort`,
 * `hook_event_name`, `tool_name`, `tool_input`, `tool_use_id` — and **no token count, no context
 * percentage, no remaining-context figure** (code.claude.com/docs/en/hooks, read 2026-08-24).
 * `transcript_path` exists, but its JSONL is an undocumented internal format and the window size
 * per model is not published either, so deriving a percentage from it would be a guess wearing a
 * number's clothes. See D-225.
 */
export const ADAPTER_UNPOPULATED_FIELDS: Readonly<Record<string, string>> = {
  contextFill: 'no agent reports context-window usage to a hook; Claude Code\'s payload has no '
    + 'token or context field at all (code.claude.com/docs/en/hooks, checked 2026-08-24)',
};

/** A policy section, the fields it reads, and how to tell whether it is switched on. */
export interface PolicyInput {
  /** Dotted path as it appears in `usewarden.yaml` and in incident `rule` strings. */
  section: string;
  /** Event fields the rule cannot evaluate without. */
  fields: readonly EventField[];
  /** Human sentence used when the section is suppressed. */
  what: string;
}

export const POLICY_INPUTS: readonly PolicyInput[] = [
  { section: 'scope.forbidden_paths', fields: ['filePath', 'command'], what: 'blocks reads of credential files' },
  { section: 'scope.allowed_paths', fields: ['filePath'], what: 'blocks writes outside the project' },
  { section: 'scope.protect_uncommitted', fields: ['filePath'], what: 'blocks overwriting work git cannot restore' },
  { section: 'commands.deny', fields: ['command'], what: 'blocks dangerous shell commands' },
  { section: 'protected_branches', fields: ['command'], what: 'blocks force-pushes to protected branches' },
  { section: 'context.warn_pct', fields: ['contextFill'], what: 'warns when the context window fills up' },
  { section: 'session.goal_required', fields: ['prompt'], what: 'requires a declared session goal' },
  { section: 'invariants', fields: ['command', 'filePath', 'prompt'], what: 'free-text rules for the Layer-2 judge' },
];

/**
 * The fields a section needs that no adapter supplies. Empty means the section can fire.
 */
export function unsupportedFields(section: string): EventField[] {
  const entry = POLICY_INPUTS.find((p) => p.section === section);
  if (!entry) return [];
  return entry.fields.filter((f) => !ADAPTER_POPULATED_FIELDS.includes(f));
}

/**
 * True when EVERY field a section needs is missing — i.e. the rule can never fire.
 *
 * Deliberately "every" rather than "any": `scope.forbidden_paths` reads both `filePath` and
 * `command` and fires on either, so losing one would narrow it rather than kill it.
 */
export function cannotEverFire(section: string): boolean {
  const entry = POLICY_INPUTS.find((p) => p.section === section);
  if (!entry || entry.fields.length === 0) return false;
  return entry.fields.every((f) => !ADAPTER_POPULATED_FIELDS.includes(f));
}

/** The reason a field is unavailable, for printing next to a suppressed rule. */
export function whyUnsupported(field: EventField): string {
  return ADAPTER_UNPOPULATED_FIELDS[field as string] ?? 'no adapter populates this field';
}
