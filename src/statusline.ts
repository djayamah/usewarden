import './boot.js';
import { Store } from './store.js';
import { buildStatus } from './status.js';
import { readStdin } from './hook.js';
import { buildReceipt, latestSessionId, receiptStatusLine } from './receipt.js';

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
    // Real sessions only. A status line that counts demo runs is a status line that lies.
    const blocked = r.metrics.live.attempts;
    const drift = r.metrics.live.drift_warnings;
    const parts = [badge];
    if (blocked) parts.push(`${blocked} blocked`);
    if (drift) parts.push(`${drift} drift`);
    if (r.unlocked) parts.push('UNLOCKED');

    // THE RECEIPT'S ONE-LINE FORM. It is the only thing here that says anything about the session
    // the user is actually in, and on a clean session it is the only thing that says anything at
    // all. Appended, never substituted: protection state stays first because "usewarden is not
    // running" is what the user most needs to see and is least likely to go looking for.
    //
    // No notification, no mid-session output, no interruption: this line is rendered by the host
    // when the host chooses to, and usewarden only answers.
    try {
      const id = latestSessionId(store);
      if (id !== null) {
        const receipt = buildReceipt(store, id);
        if (receipt) parts.push(receiptStatusLine(receipt));
      }
    } catch { /* the status line must never throw; the badge above is still true */ }

    line = parts.join(' | ');
  } catch {
    line = 'usewarden unavailable';
  } finally {
    store.close();
  }
  process.stdout.write(line);
  return 0;
}
