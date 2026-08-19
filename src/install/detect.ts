import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentId } from '../types.js';
import { agentHome } from '../paths.js';

/**
 * Agent detection by probing known config paths, NOT by running anything.
 * Running `<agent> --version` to detect an agent would mean executing whatever binary happens
 * to sit on PATH under that name, which is not something a security tool should do on install.
 * Paths come from docs/HOOK-MATRIX.md (all fetched from vendor docs 2026-08-19).
 */

export type ConfigFormat = 'json' | 'toml' | 'plugin';

export type Scope = 'user' | 'project';

export interface AgentTarget {
  agent: AgentId;
  label: string;
  /** `user` = the agent's home config; `project` = the repo-local config. */
  scope: Scope;
  /** The config file usewarden registers hooks in. */
  configPath: string;
  format: ConfigFormat;
  /** Directories/files whose presence indicates the agent is installed. */
  markers: string[];
  /** Documented caveat shown in `usewarden status`. */
  caveat?: string;
}

/**
 * Usewarden can register at two layers, and `usewarden status` reports both:
 *
 *   user     ~/.claude/settings.json etc - protects every session on the machine
 *   project  <repo>/.claude/settings.json - protects sessions in this repo, and is what a
 *            team commits so a checkout arrives already guarded
 *
 * Codex is the exception: its project layer only loads when the `.codex/` layer is trusted, and
 * IDE/desktop wrappers may skip it entirely (HOOK-MATRIX), so usewarden prefers the user layer there
 * and says so.
 */
export function agentTargets(scope: Scope = 'user', projectRoot?: string): AgentTarget[] {
  const home = scope === 'user' ? agentHome() : (projectRoot ?? process.cwd());
  if (scope === 'project') return projectTargets(home);
  return [
    {
      agent: 'claude',
      label: 'Claude Code',
      scope: 'user',
      configPath: path.join(home, '.claude', 'settings.json'),
      format: 'json',
      markers: [path.join(home, '.claude')],
    },
    {
      agent: 'gemini',
      label: 'Gemini CLI',
      scope: 'user',
      configPath: path.join(home, '.gemini', 'settings.json'),
      format: 'json',
      markers: [path.join(home, '.gemini')],
      caveat: 'Gemini CLI defaults to ALLOW if a hook prints anything but JSON on stdout. Usewarden routes all diagnostics to stderr.',
    },
    {
      agent: 'cursor',
      label: 'Cursor',
      scope: 'user',
      configPath: path.join(home, '.cursor', 'hooks.json'),
      format: 'json',
      markers: [path.join(home, '.cursor')],
      caveat: 'Cursor can also load Claude Code hooks; usewarden deduplicates repeated events by content hash.',
    },
    {
      agent: 'copilot',
      label: 'GitHub Copilot CLI',
      scope: 'user',
      configPath: path.join(home, '.copilot', 'hooks', 'usewarden.json'),
      format: 'json',
      markers: [path.join(home, '.copilot')],
    },
    {
      agent: 'codex',
      label: 'Codex CLI',
      scope: 'user',
      configPath: path.join(home, '.codex', 'hooks.json'),
      format: 'json',
      markers: [path.join(home, '.codex')],
      caveat: 'Codex IDE and desktop wrappers may ignore project config entirely; usewarden registers at the user layer. Desktop-wrapper sessions are NOT covered.',
    },
    {
      agent: 'opencode',
      label: 'OpenCode',
      scope: 'user',
      configPath: path.join(home, '.config', 'opencode', 'plugin', 'usewarden.js'),
      format: 'plugin',
      markers: [path.join(home, '.config', 'opencode')],
      caveat: 'OpenCode integration is a TypeScript plugin shim and is UNVERIFIED-LOCALLY. SDK-driven sessions are not a coverage guarantee.',
    },
  ];
}

/** Repo-local config paths. Same vendors, different layer. */
function projectTargets(root: string): AgentTarget[] {
  const user = agentTargets('user');
  const rel: Record<AgentId, string> = {
    claude: path.join('.claude', 'settings.json'),
    gemini: path.join('.gemini', 'settings.json'),
    cursor: path.join('.cursor', 'hooks.json'),
    copilot: path.join('.github', 'hooks', 'usewarden.json'),
    codex: path.join('.codex', 'hooks.json'),
    opencode: path.join('.opencode', 'plugin', 'usewarden.js'),
  };
  return user.map((t) => ({
    ...t,
    scope: 'project' as const,
    configPath: path.join(root, rel[t.agent]),
  }));
}

export interface Detection extends AgentTarget {
  installed: boolean;
  configExists: boolean;
}

export interface DetectOptions {
  scope?: Scope;
  projectRoot?: string;
}

export function detectAgents(opts: DetectOptions = {}): Detection[] {
  const scope = opts.scope ?? 'user';
  return agentTargets(scope, opts.projectRoot).map((t) => ({
    ...t,
    // "installed" always means the agent exists on this MACHINE. A project layer is only
    // useful for an agent the user actually runs.
    installed: t.markers.some((m) => existsQuiet(m)),
    configExists: existsQuiet(t.configPath),
  }));
}

/**
 * Every layer `usewarden status` should report on: the user layer, the current repo's project
 * layer, and - importantly - any project layer usewarden has previously registered ANYWHERE.
 *
 * That last part matters because protection state must not depend on which directory you
 * happen to be standing in. Running `usewarden status` from your home directory should still tell
 * you that the hooks you installed in a project are intact.
 */
export function detectAllScopes(projectRoot?: string, knownConfigPaths: readonly string[] = []): Detection[] {
  const out = detectAgents({ scope: 'user' });
  const seen = new Set(out.map((d) => d.configPath));

  if (projectRoot) {
    for (const d of detectAgents({ scope: 'project', projectRoot })) {
      if (d.installed && d.configExists && !seen.has(d.configPath)) { out.push(d); seen.add(d.configPath); }
    }
  }

  for (const p of knownConfigPaths) {
    if (seen.has(p)) continue;
    const root = projectRootOf(p);
    if (!root) continue;
    for (const d of detectAgents({ scope: 'project', projectRoot: root })) {
      if (d.configPath === p && !seen.has(p)) { out.push({ ...d, configExists: existsQuiet(p) }); seen.add(p); }
    }
  }
  return out;
}

/**
 * Recovers the project root from a registered project-layer config path by stripping the known
 * relative suffix. Returns null when the path does not look like one usewarden would have written.
 */
function projectRootOf(configPath: string): string | null {
  const suffixes = [
    path.join('.claude', 'settings.json'),
    path.join('.gemini', 'settings.json'),
    path.join('.cursor', 'hooks.json'),
    path.join('.github', 'hooks', 'usewarden.json'),
    path.join('.codex', 'hooks.json'),
    path.join('.opencode', 'plugin', 'usewarden.js'),
  ];
  for (const suf of suffixes) {
    if (configPath.endsWith(path.sep + suf)) return configPath.slice(0, -(suf.length + 1));
  }
  return null;
}

function existsQuiet(p: string): boolean {
  try { return fs.existsSync(p); } catch { return false; }
}
