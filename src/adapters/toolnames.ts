import type { AgentId, CanonicalTool } from '../types.js';

/**
 * Vendor tool id -> canonical tool name.
 *
 * Every agent names its tools differently (Claude `Bash`, Gemini `run_shell_command`, Codex
 * `apply_patch`). Keeping the table here means adding an agent is one entry, and the engine
 * never learns a vendor's vocabulary. Source for each vendor's ids: docs/HOOK-MATRIX.md.
 */
const TABLE: Record<AgentId, Record<string, CanonicalTool>> = {
  claude: {
    Bash: 'bash', BashOutput: 'bash', KillShell: 'bash',
    Read: 'read', NotebookRead: 'read',
    Write: 'write', NotebookEdit: 'edit', Edit: 'edit', MultiEdit: 'edit',
    Glob: 'glob', Grep: 'grep',
    WebFetch: 'web', WebSearch: 'web',
    Task: 'task', Agent: 'task',
  },
  gemini: {
    run_shell_command: 'bash', shell: 'bash',
    read_file: 'read', read_many_files: 'read',
    write_file: 'write', replace: 'edit', edit: 'edit',
    glob: 'glob', search_file_content: 'grep', grep: 'grep',
    web_fetch: 'web', google_web_search: 'web',
  },
  cursor: {
    shell: 'bash', run_terminal_cmd: 'bash',
    read_file: 'read', write: 'write', edit_file: 'edit', search_replace: 'edit',
    glob_file_search: 'glob', grep: 'grep', codebase_search: 'grep',
    web_search: 'web', fetch_rules: 'read',
  },
  copilot: {
    bash: 'bash', shell: 'bash',
    view: 'read', read: 'read',
    create: 'write', write: 'write', edit: 'edit', str_replace: 'edit',
    glob: 'glob', grep: 'grep', search: 'grep',
    fetch: 'web',
  },
  codex: {
    Bash: 'bash', shell: 'bash', local_shell: 'bash',
    apply_patch: 'edit', read_file: 'read', write_file: 'write',
    grep: 'grep', glob: 'glob', web_search: 'web',
  },
  opencode: {
    bash: 'bash', read: 'read', write: 'write', edit: 'edit', patch: 'edit',
    glob: 'glob', grep: 'grep', webfetch: 'web', task: 'task',
  },
};

export function canonicalTool(agent: AgentId, rawTool: string | undefined): CanonicalTool {
  if (!rawTool) return 'other';
  if (rawTool.startsWith('mcp__') || rawTool.startsWith('mcp.')) return 'mcp';
  const t = TABLE[agent][rawTool];
  if (t) return t;
  // Case-insensitive second pass: vendors are inconsistent about casing across surfaces.
  const lower = rawTool.toLowerCase();
  for (const [k, v] of Object.entries(TABLE[agent])) {
    if (k.toLowerCase() === lower) return v;
  }
  return 'other';
}

/**
 * Best-effort extraction of the filesystem target from a tool input object, without knowing
 * which agent produced it. Only key names are inspected; values are never executed.
 */
export function extractPath(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  const keys = ['file_path', 'filePath', 'path', 'absolute_path', 'notebook_path', 'target_file', 'file'];
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string' && v !== '') return v;
  }
  return undefined;
}

export function extractCommand(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  for (const k of ['command', 'cmd', 'script', 'shell_command']) {
    const v = input[k];
    if (typeof v === 'string' && v !== '') return v;
  }
  return undefined;
}
