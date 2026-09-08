/**
 * Ask the REAL hook binary for a verdict on each case in .usewarden-tmp/probe-cases.txt.
 *
 * WHY THIS IS A FILE AND NOT A SHELL LOOP. The first attempt put the cases inline in a bash
 * `for`, and usewarden blocked the command that was trying to measure usewarden — the case
 * strings ARE dangerous commands, and Layer 1 matches raw command text. That is the documented
 * "text about a command is mistaken for the command" limitation, hit while writing the section
 * of the README that describes it. Reading the cases from a data file sidesteps it entirely,
 * which is also the workaround the README recommends to users.
 *
 * NOTHING HERE IS EXECUTED. Each case is handed to `usewarden hook claude pre_tool` as a
 * DECLARED tool input — exactly the shape Claude Code sends before running a Bash tool call —
 * and the hook's verdict is read back. The commands never reach a shell.
 *
 * Usage: node scripts/probe-native-gap.mjs
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = path.join(REPO, 'fixtures', 'sandbox-project');
const HOME = path.join(REPO, '.usewarden-tmp', 'probe-home');
const CASES = path.join(REPO, '.usewarden-tmp', 'probe-cases.txt');

// CLAUDE.md §1: sabotage input is only ever evaluated against the sandbox fixture, and a symlink
// is not a fence. Resolve and check before anything else.
const resolved = fs.realpathSync(SANDBOX);
if (path.basename(resolved) !== 'sandbox-project') {
  throw new Error(`refusing: sandbox resolved to ${resolved}`);
}

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });

// A REAL, CONFIGURED FORBIDDEN PATH.
//
// The first version of this probe ran on the DEFAULT policy and reported that a read of
// ~/Documents was allowed. True, and misleading: ~/Documents is not in the default
// forbidden_paths - it is in the OPERATOR's policy on this machine. Measuring the default and
// describing the configured case would have put a false sentence in the README. So the probe
// configures the path it is about to test, and the sandbox directory below is created for real
// so nothing here depends on a path that does not exist.
const FORBIDDEN = path.join(REPO, '.usewarden-tmp', 'private-dir');
fs.mkdirSync(FORBIDDEN, { recursive: true });
fs.writeFileSync(path.join(FORBIDDEN, 'notes.md'), 'pretend this is private\n');
fs.writeFileSync(path.join(HOME, 'usewarden.yaml'),
  `version: 1\nscope:\n  forbidden_paths:\n    - ${FORBIDDEN}\n`);

function verdictFor(tool, arg) {
  // Bash carries `command`; every file tool carries `file_path` (src/adapters/toolnames.ts:69).
  // Sending the right key for the tool is the whole difference between measuring the shell path
  // and measuring the file path, and they do NOT give the same answer.
  const toolInput = tool === 'Bash' ? { command: arg } : { file_path: arg };
  const payload = JSON.stringify({
    hook_event_name: 'PreToolUse',
    session_id: 'probe-native-gap',
    cwd: resolved,
    tool_name: tool,
    tool_input: toolInput,
  });
  const r = spawnSync(process.execPath, ['dist/src/cli.js', 'hook', 'claude', 'pre_tool'], {
    input: payload, cwd: REPO, encoding: 'utf8',
    env: { ...process.env, USEWARDEN_HOME: HOME },
  });
  const out = (r.stdout || '').trim();
  if (out === '') return { kind: 'ALLOW', why: 'the hook said nothing, which is how it allows' };
  try {
    const j = JSON.parse(out);
    const h = j.hookSpecificOutput ?? {};
    if (h.permissionDecision === 'deny') return { kind: 'DENY', why: h.permissionDecisionReason };
    if (j.systemMessage) return { kind: 'WARN', why: j.systemMessage };
    return { kind: 'ALLOW', why: 'allowed with no message' };
  } catch {
    return { kind: 'ALLOW', why: `unparseable stdout: ${out.slice(0, 80)}` };
  }
}

const rows = fs.readFileSync(CASES, 'utf8').split('\n')
  .map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'))
  .map((l) => { const [group, title, tool, ...rest] = l.split('|');
    return { group, title, tool, cmd: rest.join('|').replace(/@FORBIDDEN@/g, FORBIDDEN) }; });

console.log('=== WHAT USEWARDEN DOES AND DOES NOT CATCH — asked of the real hook binary ===');
console.log(`date        ${new Date().toISOString()}`);
console.log(`version     ${spawnSync(process.execPath, ['dist/src/cli.js', '--version'], { cwd: REPO, encoding: 'utf8' }).stdout.trim()}`);
console.log(`cwd probed  fixtures/sandbox-project`);
console.log('Nothing is executed. Each command is a DECLARED tool input; the hook returns a verdict.\n');

let group = '';
const summary = [];
for (const r of rows) {
  if (r.group !== group) { group = r.group; console.log(`--- ${group}. ${r.title} ---`); }
  const v = verdictFor(r.tool, r.cmd);
  summary.push({ group, cmd: r.cmd, kind: v.kind });
  // Redact by construction (CLAUDE.md §2). This transcript is committed to `verification/`,
  // which is published, and a block REASON quotes the resolved allowed path — which is this
  // machine's home directory. Found by pointing the identity scan at what this run had already
  // written rather than only at what it was about to publish.
  const scrub = (x) => String(x)
    .split(FORBIDDEN).join('<forbidden-dir>')
    .split(REPO).join('<repo>')
    .replace(/\/(?:Users|home)\/[^/\s"')]+/g, '~');
  console.log(`  ${v.kind.padEnd(5)}  [${r.tool}] ${scrub(r.cmd)}`);
  console.log(`         ${scrub(v.why)}\n`);
}

console.log('=== THE POINT ===');
const g = (k) => summary.filter((s) => s.group === k);
const n = (k, kind) => g(k).filter((s) => s.kind === kind).length;
const line = (k, label) => console.log(`${k}  ${label.padEnd(52, '.')} ${n(k, 'DENY')}/${g(k).length} blocked`);
line('A', 'blocking usewarden performs');
line('B', 'out-of-scope write via shell redirect');
line('C', 'out-of-scope write via a subprocess');
line('D', 'configured forbidden path, via the FILE tool');
line('E', 'configured forbidden path, via a SHELL command');
line('F', 'out-of-scope write, via the FILE tool');
console.log('');
console.log('B and C are the cases Claude Code\'s own controls cover and usewarden does not:');
console.log('  - a deny rule checks a redirection target as a file write;');
console.log('  - the OS sandbox (seatbelt/bubblewrap) confines Bash AND its child processes,');
console.log('    so C is stopped below the agent entirely, where no hook can see it.');
console.log('');
console.log('D vs E is the finding this probe existed to settle, and it is not what the');
console.log('comparison table assumed. Read the two numbers next to each other.');
