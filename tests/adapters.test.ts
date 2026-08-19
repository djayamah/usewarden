import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getAdapter } from '../src/adapters/registry.js';
import { AGENT_IDS, type AgentId, type Verdict } from '../src/types.js';
import { sandbox, gitInit, type Sandbox } from './helpers.js';

let sb: Sandbox;
beforeEach(() => { sb = sandbox(); gitInit(sb.repo); });
afterEach(() => { sb.cleanup(); });

const DENY: Verdict = { decision: 'deny', reason: 'Usewarden: nope, do not do that.', layer: 1, severity: 'block' };
const ALLOWV: Verdict = { decision: 'allow', reason: '', layer: 1, severity: 'info' };
const WARNV: Verdict = { decision: 'allow', reason: 'Usewarden: careful.', layer: 1, severity: 'warn' };

/**
 * CONTRACT TESTS.
 *
 * Cursor, Copilot, Codex and OpenCode are not installed on this build machine, so these adapters
 * are UNVERIFIED-LOCALLY. What CAN be proved without the vendor present is that usewarden speaks
 * each documented contract exactly: the payload shapes below are transcribed from the vendor
 * docs recorded in docs/HOOK-MATRIX.md (fetched 2026-08-19), and the outputs are asserted
 * field by field against each vendor's documented deny dialect.
 */

describe('every adapter: universal invariants', () => {
  for (const id of AGENT_IDS) {
    test(`${id}: render never writes to stderr and never exits non-zero on a deny`, () => {
      const a = getAdapter(id);
      const e = { agent: id, event: 'pre_tool' as const, sessionId: 's', cwd: sb.repo, ts: Date.now(), tool: 'bash' as const, command: 'x' };
      const r = a.render(DENY, e);
      assert.equal(r.stderr, '', 'stderr must stay clean - Claude Code and Codex surface it as the block reason');
      assert.notEqual(r.exitCode, 1);
    });

    test(`${id}: stdout is either empty or EXACTLY one JSON document`, () => {
      const a = getAdapter(id);
      const e = { agent: id, event: 'pre_tool' as const, sessionId: 's', cwd: sb.repo, ts: Date.now(), tool: 'bash' as const, command: 'x' };
      for (const v of [DENY, ALLOWV, WARNV]) {
        const out = a.render(v, e).stdout;
        if (out === '') continue;
        const parsed: unknown = JSON.parse(out);
        assert.equal(typeof parsed, 'object');
        assert.equal(JSON.stringify(parsed).length, out.length, 'no trailing bytes after the document');
      }
    });

    test(`${id}: an unmodelled event yields null rather than a guess`, () => {
      const a = getAdapter(id);
      assert.equal(a.parse({ hook_event_name: 'SomethingUsewardenDoesNotModel' }, ['x', 'nonsense']), null);
    });
  }
});

describe('Gemini CLI adapter', () => {
  const a = getAdapter('gemini');

  test('parses a documented BeforeTool payload', () => {
    const e = a.parse({
      session_id: 'g1', transcript_path: '/t.json', cwd: '/repo', hook_event_name: 'BeforeTool',
      timestamp: '2026-08-19T00:00:00Z', tool_name: 'run_shell_command',
      tool_input: { command: 'rm -rf /' },
    }, [])!;
    assert.equal(e.agent, 'gemini');
    assert.equal(e.event, 'pre_tool');
    assert.equal(e.tool, 'bash', 'run_shell_command must normalize to bash');
    assert.equal(e.command, 'rm -rf /');
  });

  test('maps its own file-tool vocabulary', () => {
    const e = a.parse({ hook_event_name: 'BeforeTool', tool_name: 'write_file', tool_input: { file_path: '/r/x.ts' }, cwd: '/r', session_id: 'g' }, [])!;
    assert.equal(e.tool, 'write');
    assert.equal(e.filePath, '/r/x.ts');
  });

  test('deny uses Gemini decision/reason, NOT the Claude shape', () => {
    const e = a.parse({ hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: {}, cwd: '/r', session_id: 'g' }, [])!;
    const j = JSON.parse(a.render(DENY, e).stdout);
    assert.equal(j.decision, 'deny');
    assert.equal(j.reason, DENY.reason);
    assert.equal(j.hookSpecificOutput, undefined, 'Gemini does not understand hookSpecificOutput');
  });

  test('T-11: an allow still emits a VALID EMPTY JSON DOCUMENT, never empty stdout', () => {
    // Measured against a live Gemini CLI: empty stdout is a parse failure to it, reported as
    // "0 succeeded, 1 failed" on every event. `{}` carries no decision and parses cleanly.
    const e = a.parse({ hook_event_name: 'BeforeTool', tool_name: 'read_file', tool_input: {}, cwd: '/r', session_id: 'g' }, [])!;
    assert.equal(a.render(ALLOWV, e).stdout, '{}');
    const sess = a.parse({ hook_event_name: 'SessionStart', cwd: '/r', session_id: 'g' }, [])!;
    assert.equal(a.render(ALLOWV, sess).stdout, '{}');
  });
});

describe('Cursor adapter', () => {
  const a = getAdapter('cursor');

  test('parses the documented beforeShellExecution payload', () => {
    const e = a.parse({
      command: 'git push --force origin main', cwd: '/repo', sandbox: false,
      conversation_id: 'c1', generation_id: 'g1', model: 'x', hook_event_name: 'beforeShellExecution',
      cursor_version: '1.7.0', workspace_roots: ['/repo'], user_email: null, transcript_path: null,
    }, [])!;
    assert.equal(e.agent, 'cursor');
    assert.equal(e.event, 'pre_tool');
    assert.equal(e.tool, 'bash');
    assert.equal(e.command, 'git push --force origin main');
    assert.equal(e.sessionId, 'c1', 'Cursor calls it conversation_id');
  });

  test('parses beforeReadFile as a read, not an edit', () => {
    const e = a.parse({
      file_path: '/repo/.env', content: 'SECRET=1', attachments: [],
      conversation_id: 'c1', hook_event_name: 'beforeReadFile', workspace_roots: ['/repo'],
    }, [])!;
    assert.equal(e.tool, 'read');
    assert.equal(e.filePath, '/repo/.env');
  });

  test('falls back to workspace_roots when cwd is absent', () => {
    const e = a.parse({ command: 'ls', hook_event_name: 'beforeShellExecution', workspace_roots: ['/ws'], conversation_id: 'c' }, [])!;
    assert.equal(e.cwd, '/ws');
  });

  test('deny uses Cursor permission/user_message/agent_message', () => {
    const e = a.parse({ command: 'x', hook_event_name: 'beforeShellExecution', conversation_id: 'c', cwd: '/r' }, [])!;
    const j = JSON.parse(a.render(DENY, e).stdout);
    assert.equal(j.permission, 'deny');
    assert.equal(j.user_message, DENY.reason);
    assert.equal(j.agent_message, DENY.reason);
  });

  test('allow is explicit, because Cursor expects a permission on every call', () => {
    const e = a.parse({ command: 'x', hook_event_name: 'beforeShellExecution', conversation_id: 'c', cwd: '/r' }, [])!;
    assert.equal(JSON.parse(a.render(ALLOWV, e).stdout).permission, 'allow');
  });
});

describe('GitHub Copilot CLI adapter', () => {
  const a = getAdapter('copilot');

  test('parses the documented camelCase preToolUse payload', () => {
    const e = a.parse({
      sessionId: 'cp1', timestamp: 1_700_000_000, cwd: '/repo',
      toolName: 'bash', toolArgs: { command: 'sudo rm -rf /' },
    }, ['copilot', 'pre_tool'])!;
    assert.equal(e.agent, 'copilot');
    assert.equal(e.event, 'pre_tool');
    assert.equal(e.sessionId, 'cp1');
    assert.equal(e.tool, 'bash');
    assert.equal(e.command, 'sudo rm -rf /');
  });

  test('maps Copilot tool names (view/create) onto the canonical set', () => {
    const view = a.parse({ sessionId: 's', cwd: '/r', toolName: 'view', toolArgs: { path: '/r/a' } }, ['copilot', 'pre_tool'])!;
    assert.equal(view.tool, 'read');
    assert.equal(view.filePath, '/r/a');
    const create = a.parse({ sessionId: 's', cwd: '/r', toolName: 'create', toolArgs: { path: '/r/b' } }, ['copilot', 'pre_tool'])!;
    assert.equal(create.tool, 'write');
  });

  test('deny uses permissionDecision + permissionDecisionReason', () => {
    const e = a.parse({ sessionId: 's', cwd: '/r', toolName: 'bash', toolArgs: {} }, ['copilot', 'pre_tool'])!;
    const j = JSON.parse(a.render(DENY, e).stdout);
    assert.equal(j.permissionDecision, 'deny');
    assert.equal(j.permissionDecisionReason, DENY.reason);
    assert.equal(j.hookSpecificOutput, undefined, 'Copilot reads the fields at the top level');
  });
});

describe('Codex CLI adapter', () => {
  const a = getAdapter('codex');

  test('parses the documented PreToolUse payload including apply_patch', () => {
    const e = a.parse({
      session_id: 'cx1', turn_id: 't1', cwd: '/repo', hook_event_name: 'PreToolUse',
      model: 'x', permission_mode: 'default', tool_name: 'apply_patch',
      tool_use_id: 'u1', tool_input: { file_path: '/repo/a.ts' }, transcript_path: null,
    }, [])!;
    assert.equal(e.agent, 'codex');
    assert.equal(e.tool, 'edit', 'apply_patch is an edit');
    assert.equal(e.filePath, '/repo/a.ts');
  });

  test('deny uses the MODERN hookSpecificOutput shape only', () => {
    const e = a.parse({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {}, cwd: '/r', session_id: 'c' }, [])!;
    const j = JSON.parse(a.render(DENY, e).stdout);
    assert.equal(j.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(j.hookSpecificOutput.permissionDecisionReason, DENY.reason);
    assert.equal(j.decision, undefined, 'emitting both the modern and legacy keys would be ambiguous');
  });
});

describe('OpenCode adapter', () => {
  const a = getAdapter('opencode');

  test('parses the payload usewarden own plugin constructs', () => {
    const e = a.parse({
      hook_event_name: 'tool.execute.before', agent: 'opencode', tool_name: 'bash',
      tool_input: { command: 'rm -rf /' }, session_id: 'oc1', cwd: '/repo',
    }, ['opencode', 'pre_tool'])!;
    assert.equal(e.tool, 'bash');
    assert.equal(e.command, 'rm -rf /');
  });

  test('deny is shaped exactly as the generated plugin parses it', () => {
    const e = a.parse({ tool_name: 'bash', tool_input: {}, session_id: 's', cwd: '/r' }, ['opencode', 'pre_tool'])!;
    const j = JSON.parse(a.render(DENY, e).stdout);
    // src/install/entries.ts openCodePlugin() reads exactly this path and throws the reason.
    assert.equal(j.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(j.hookSpecificOutput.permissionDecisionReason, DENY.reason);
  });

  test('an allow produces silence, so the plugin does not throw', () => {
    const e = a.parse({ tool_name: 'bash', tool_input: {}, session_id: 's', cwd: '/r' }, ['opencode', 'pre_tool'])!;
    assert.equal(a.render(ALLOWV, e).stdout, '');
  });
});

// ---------------------------------------------------------------------------
// The real subprocess test: what actually comes out of the hook binary.
// ---------------------------------------------------------------------------

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

function runHookProcess(agent: AgentId, kind: string, payload: unknown):
{ stdout: string; stderr: string; status: number } {
  const res = execFileSync(process.execPath, [CLI, 'hook', agent, kind], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, USEWARDEN_HOME: sb.usewardenHome, USEWARDEN_AGENT_HOME: sb.agentHome, USEWARDEN_JUDGE_NO_LOCAL: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { stdout: res, stderr: '', status: 0 };
}

describe('T-11: the real hook subprocess writes NOTHING but one JSON document', () => {
  test('gemini deny path: stdout parses as exactly one document, stderr is empty', () => {
    fs.writeFileSync(path.join(sb.usewardenHome, 'usewarden.yaml'),
      `version: 1\nscope:\n  allowed_paths:\n    - ${JSON.stringify(sb.repo)}\n`);
    const out = runHookProcess('gemini', 'pre_tool', {
      hook_event_name: 'BeforeTool', session_id: 'live', cwd: sb.repo,
      tool_name: 'run_shell_command', tool_input: { command: 'cat .env' },
    });
    assert.notEqual(out.stdout, '', 'a denied command must produce a verdict');
    const j = JSON.parse(out.stdout);
    assert.equal(j.decision, 'deny');
    assert.equal(JSON.stringify(j).length, out.stdout.length,
      'a single stray byte on stdout makes Gemini CLI default to ALLOW');
  });

  test('gemini allow path: stdout is exactly the empty JSON document', () => {
    const out = runHookProcess('gemini', 'pre_tool', {
      hook_event_name: 'BeforeTool', session_id: 'live2', cwd: sb.repo,
      tool_name: 'read_file', tool_input: { file_path: path.join(sb.repo, 'README.md') },
    });
    assert.equal(out.stdout, '{}');
  });

  test('a malformed payload fails OPEN and still writes nothing', () => {
    const res = execFileSync(process.execPath, [CLI, 'hook', 'gemini', 'pre_tool'], {
      input: 'this is not json at all',
      encoding: 'utf8',
      env: { ...process.env, USEWARDEN_HOME: sb.usewardenHome, USEWARDEN_AGENT_HOME: sb.agentHome },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    assert.equal(res, '', 'a usewarden bug must never emit garbage into the vendor protocol');
  });
});
