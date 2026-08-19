import './boot.js';
import type { AgentId, EventKind, NormalizedEvent } from './types.js';
import { AGENT_IDS } from './types.js';
import { Store } from './store.js';
import { handleEvent } from './engine/pipeline.js';
import { getAdapter } from './adapters/registry.js';
import { logPath } from './paths.js';
import * as fs from 'node:fs';

/**
 * The hook entrypoint - the only code path that runs inside a live agent session.
 *
 * Hard rules, each with a test:
 *   H1  EXACTLY ONE JSON document on stdout, or nothing. A stray byte makes Gemini CLI default
 *       to Allow (HOOK-MATRIX / THREAT-MODEL T-11), which silently disables protection.
 *   H2  Every diagnostic goes to stderr, and stderr stays empty unless we are deliberately
 *       using the exit-2 channel - Claude Code and Codex surface stderr as the block reason.
 *   H3  Never throw. Any internal failure fails OPEN (allow) with a log line, because a
 *       guardian that crashes the user's agent gets uninstalled within the hour.
 *   H4  Bounded. Reading stdin, evaluating, and writing the verdict has a hard deadline well
 *       inside every vendor's hook timeout.
 */

const HOOK_DEADLINE_MS = 8000;

export async function runHook(argv: string[]): Promise<number> {
  const agent = argv[0] as AgentId | undefined;
  const kindArg = argv[1];
  if (!agent || !AGENT_IDS.includes(agent)) {
    process.stderr.write(`usewarden: unknown agent "${String(agent)}"\n`);
    return 1;
  }

  let raw: unknown;
  try {
    const text = await readStdin(HOOK_DEADLINE_MS);
    raw = text.trim() === '' ? {} : JSON.parse(text);
  } catch (e) {
    logQuiet(`stdin parse failed: ${(e as Error).message}`);
    return 0; // H3: fail open
  }

  const adapter = getAdapter(agent);
  let event: NormalizedEvent | null = null;
  try {
    event = adapter.parse(raw, argv);
  } catch (e) {
    logQuiet(`parse failed: ${(e as Error).message}`);
    return 0;
  }
  if (!event) {
    // The vendor sent an event usewarden does not model. Silence is the correct response.
    return 0;
  }
  // The argv kind is authoritative when the payload does not name the event (Cursor, OpenCode).
  if (kindArg && isEventKind(kindArg) && event.event === 'pre_tool') {
    event.event = kindArg;
  }

  let store: Store | undefined;
  try {
    store = new Store();
    const result = await Promise.race([
      handleEvent(store, event, { live: true, judgeMode: 'detached' }),
      timeout(HOOK_DEADLINE_MS),
    ]);
    if (result === 'timeout') {
      logQuiet('evaluation exceeded deadline; failing open');
      return 0;
    }
    for (const w of result.warnings) logQuiet(w);
    const rendered = adapter.render(result.verdict, event);
    if (rendered.stdout !== '') process.stdout.write(rendered.stdout);
    if (rendered.stderr !== '') process.stderr.write(rendered.stderr);
    return rendered.exitCode;
  } catch (e) {
    logQuiet(`hook failed open: ${(e as Error).stack ?? String(e)}`);
    return 0;
  } finally {
    store?.close();
  }
}

function isEventKind(s: string): s is EventKind {
  return ['session_start', 'session_end', 'user_prompt', 'pre_tool', 'post_tool', 'pre_compact', 'config_change'].includes(s);
}

function timeout(ms: number): Promise<'timeout'> {
  return new Promise((resolve) => { const t = setTimeout(() => resolve('timeout'), ms); t.unref(); });
}

export function readStdin(ms: number): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) { resolve(''); return; }
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => { cleanup(); resolve(Buffer.concat(chunks).toString('utf8')); }, ms);
    const onData = (c: Buffer) => chunks.push(c);
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks).toString('utf8')); };
    const onErr = (e: Error) => { cleanup(); reject(e); };
    const cleanup = () => {
      clearTimeout(timer);
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.off('error', onErr);
    };
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onErr);
  });
}

/**
 * H2: usewarden's own diagnostics NEVER go to the agent. They go to a log file. If the log cannot
 * be written the message is dropped - there is no fallback to stdout or stderr, because either
 * would corrupt the vendor protocol.
 */
export function logQuiet(msg: string): void {
  if (process.env['USEWARDEN_DEBUG'] === '1') process.stderr.write(`[usewarden] ${msg}\n`);
  try {
    fs.appendFileSync(logPath(), `${new Date().toISOString()} ${msg}\n`, { mode: 0o600 });
  } catch { /* deliberately swallowed - see H2 */ }
}
