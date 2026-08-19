import './boot.js';
import { Store } from './store.js';
import { buildStatus } from './status.js';
import { readStdin } from './hook.js';

/**
 * Claude Code status-line integration.
 *
 * Registered as `statusLine: { type: "command", command: "<node> <usewarden> statusline" }`.
 * Claude Code passes a JSON blob on stdin and renders one line of stdout under the prompt, so
 * the constraints are: one line, no ANSI that would fight the host theme, and fast. It must
 * also never throw - a status line that errors is a status line the user turns off.
 *
 * The line always leads with protection state, because "usewarden is not actually running" is the
 * thing the user most needs to see and the thing they are least likely to go looking for.
 */
export async function runStatusLine(): Promise<number> {
  try {
    await readStdin(1000); // drain Claude Code's payload; usewarden does not need any of it
  } catch { /* no payload is fine */ }

  let line = 'usewarden ?';
  const store = new Store();
  try {
    const r = buildStatus(store, process.cwd());
    const badge = r.overall === 'PROTECTED' ? 'usewarden ok' : `usewarden ${r.overall}`;
    const blocked = r.counters['actions_blocked'] ?? 0;
    const drift = r.counters['drift_caught'] ?? 0;
    const parts = [badge];
    if (blocked) parts.push(`${blocked} blocked`);
    if (drift) parts.push(`${drift} drift`);
    if (r.unlocked) parts.push('UNLOCKED');
    line = parts.join(' | ');
  } catch {
    line = 'usewarden unavailable';
  } finally {
    store.close();
  }
  process.stdout.write(line);
  return 0;
}
