import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AgentId, NormalizedEvent } from '../src/types.js';

/**
 * Every test runs against a throwaway USEWARDEN_HOME and a throwaway agent HOME so nothing in the
 * suite can touch the real user's config. `withTempHome` also asserts the sandbox actually took
 * effect rather than trusting the env var - see the path rules in SPEC-BUILD.md.
 */
export function tempDir(prefix = 'usewarden-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export interface Sandbox {
  root: string;
  usewardenHome: string;
  agentHome: string;
  repo: string;
  cleanup(): void;
}

export function sandbox(): Sandbox {
  const root = tempDir();
  const usewardenHome = path.join(root, 'usewarden-home');
  const agentHome = path.join(root, 'agent-home');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(usewardenHome, { recursive: true });
  fs.mkdirSync(agentHome, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  process.env['USEWARDEN_HOME'] = usewardenHome;
  process.env['USEWARDEN_AGENT_HOME'] = agentHome;
  return {
    root, usewardenHome, agentHome, repo,
    cleanup() {
      delete process.env['USEWARDEN_HOME'];
      delete process.env['USEWARDEN_AGENT_HOME'];
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

export function gitInit(dir: string, branch = 'main'): void {
  fs.mkdirSync(dir, { recursive: true });
  run('git', ['-C', dir, 'init', '-q', '-b', branch]);
  run('git', ['-C', dir, 'config', 'user.email', 'test@example.invalid']);
  run('git', ['-C', dir, 'config', 'user.name', 'usewarden test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  run('git', ['-C', dir, 'add', '-A']);
  run('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
}

export function run(bin: string, args: string[]): string {
  return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

let seq = 0;
export function ev(partial: Partial<NormalizedEvent> & { agent?: AgentId }): NormalizedEvent {
  return {
    agent: partial.agent ?? 'claude',
    event: partial.event ?? 'pre_tool',
    sessionId: partial.sessionId ?? 'test-session',
    cwd: partial.cwd ?? process.cwd(),
    // Distinct timestamps by default so the 2s dedupe bucket does not collapse unrelated events.
    ts: partial.ts ?? (Date.now() + (seq++ * 5000)),
    ...partial,
  } as NormalizedEvent;
}
