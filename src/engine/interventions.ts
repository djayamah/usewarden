import { execFileSync } from 'node:child_process';
import type { NormalizedEvent, Verdict } from '../types.js';
import type { Policy } from '../policy/schema.js';

/**
 * Interventions are what usewarden DOES about a verdict, as opposed to what it says.
 *
 * Every subprocess in this file is spawned with `execFileSync(bin, argvArray)`. There is no
 * `shell: true` anywhere in usewarden, and no argument is ever built by concatenating event data
 * into a command string (docs/THREAT-MODEL.md T-05, proved by tests/sabotage/shell-injection).
 */

export interface InterventionResult {
  kind: 'block' | 'warn' | 'checkpoint' | 'compact-advice';
  detail: string;
  ok: boolean;
}

export function applyInterventions(
  v: Verdict,
  e: NormalizedEvent,
  policy: Policy,
  repoRoot: string | undefined,
): InterventionResult[] {
  const out: InterventionResult[] = [];

  if (v.advice === 'compact-advice') {
    out.push({ kind: 'compact-advice', detail: compactAdvice(e), ok: true });
    return out;
  }

  if (v.severity === 'block') {
    out.push({ kind: 'block', detail: v.reason, ok: true });
    if (policy.checkpoint.auto && repoRoot && isDestructive(v)) {
      out.push(checkpoint(repoRoot, e.sessionId));
    }
    return out;
  }

  out.push({ kind: 'warn', detail: v.reason, ok: true });
  return out;
}

function isDestructive(v: Verdict): boolean {
  const r = v.rule ?? '';
  return /rm-rf|git-reset-hard|force-push|history-rewrite/.test(r);
}

/**
 * Takes a git checkpoint before the first risky operation in a session, so the human always has
 * a named ref to get back to. Tag name is derived from the session id with everything outside
 * [A-Za-z0-9_-] stripped - a session id is agent-supplied and therefore untrusted input.
 */
export function checkpoint(repoRoot: string, sessionId: string): InterventionResult {
  const safeId = sessionId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'session';
  const tag = `usewarden/checkpoint/${safeId}-${Date.now()}`;
  try {
    const head = git(repoRoot, ['rev-parse', '--verify', 'HEAD']).trim();
    if (!head) return { kind: 'checkpoint', detail: 'no commits yet; nothing to checkpoint', ok: false };
    git(repoRoot, ['tag', '-f', tag, head]);
    return { kind: 'checkpoint', detail: `git tag ${tag} -> ${head.slice(0, 12)}`, ok: true };
  } catch (err) {
    return { kind: 'checkpoint', detail: `checkpoint failed: ${(err as Error).message}`, ok: false };
  }
}

export function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
    // No shell. No env inheritance of anything that could redirect git.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
}

function compactAdvice(e: NormalizedEvent): string {
  const pct = typeof e.contextFill === 'number' ? Math.round(e.contextFill * 100) : undefined;
  return [
    pct !== undefined ? `Context is ${pct}% full.` : 'Context is filling up.',
    'Compact now. Preserve in the summary:',
    '  - the declared session goal',
    '  - every decision made and why',
    '  - files already changed and what is left',
    '  - anything usewarden blocked, so it is not retried after the compaction',
  ].join('\n');
}
