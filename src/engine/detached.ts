import './../boot.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { NormalizedEvent, Verdict } from '../types.js';
import { usewardenHome } from '../paths.js';
import { nodePath, usewardenScriptPath } from '../install/installer.js';

/**
 * Layer 2 runs OUT OF BAND.
 *
 * The judge takes seconds - a local agent CLI can take tens of seconds - while every vendor
 * gives a hook a timeout in the low tens of seconds and the user is sitting there waiting.
 * Since a Layer-2 verdict can only ever WARN (it is sampled, fallible and prompt-injectable, so
 * it is never allowed to block), there is no reason for it to be on the response path at all.
 *
 * So the hook returns the Layer-1 verdict immediately and hands the judge to a detached child
 * that records its finding into the same SQLite store. The finding shows up in `usewarden status`,
 * the dashboard, and the incident wall moments later.
 *
 * The child is spawned with a fixed argv (node, usewarden script, `judge-run`, a payload PATH) -
 * the payload itself never appears on the command line (THREAT-MODEL T-05).
 */

export function pendingDir(): string { return path.join(usewardenHome(), 'pending'); }

export interface JudgePayload {
  event: NormalizedEvent;
  layer1: Verdict;
  live: boolean;
}

/** Writes the payload and forks the judge. Returns the payload path, or null if it could not. */
export function dispatchJudge(payload: JudgePayload): string | null {
  try {
    const dir = pendingDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${randomUUID()}.json`);
    fs.writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });

    const child = spawn(nodePath(), [usewardenScriptPath(), 'judge-run', file], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, USEWARDEN_DETACHED: '1' },
    });
    child.unref();
    return file;
  } catch {
    // Failing to dispatch the judge is a fail-OPEN condition, exactly like the judge being down.
    return null;
  }
}

export function readPayload(file: string): JudgePayload | null {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const p = JSON.parse(raw) as JudgePayload;
    if (!p || typeof p !== 'object' || !p.event) return null;
    return p;
  } catch {
    return null;
  }
}

export function discardPayload(file: string): void {
  try { fs.rmSync(file); } catch { /* already gone */ }
}
