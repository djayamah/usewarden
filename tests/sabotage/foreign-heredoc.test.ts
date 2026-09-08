import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { bodyIsForeignSource, evaluateLayer1, stripDataHeredocs } from '../../src/engine/layer1.js';
import { defaultPolicy } from '../../src/policy/schema.js';
import type { NormalizedEvent } from '../../src/types.js';

/**
 * A HEREDOC HANDED TO PYTHON IS PYTHON, NOT SHELL — AND THE DANGEROUS CASES MUST STILL FAIL CLOSED.
 *
 * This file is ordered the way CLAUDE.md §4.2 requires: **the escape cases come first**, and each
 * one asserts the dangerous construct is really present in the string under test before asserting
 * that usewarden refuses it. A permissive change of this kind is only worth as much as its
 * failing-closed tests, and a test that passed because the payload was silently missing from the
 * fixture would be worse than no test at all.
 *
 * Why the change exists: over six days of real traffic, 35 of 59 recorded blocks fired on text
 * ABOUT a command rather than a command. Most were already fixed by D-139; the residue was two
 * shapes, and the common one was `python3 - <<'PY'` — the single most usual way an agent edits a
 * file — whose body is Python source being matched against shell deny patterns (D-256).
 */

const REPO = '/repo';

function bashEvent(command: string): NormalizedEvent {
  return {
    agent: 'claude', event: 'pre_tool', sessionId: 'sab-foreign', cwd: REPO,
    ts: 1_700_000_000_000, tool: 'bash', rawTool: 'Bash', command,
  };
}

function verdict(command: string): string {
  return evaluateLayer1(bashEvent(command), { policy: defaultPolicy(REPO), repoRoot: REPO }).decision;
}

describe('sabotage: a foreign-source heredoc must still fail closed', () => {
  // --- ESCAPE CASES FIRST. Each asserts the payload landed before asserting the catch. --------

  test('python heredoc that shells out with os.system is NOT treated as data', () => {
    const cmd = [
      "python3 - <<'PY'",
      'import os',
      'os.system("rm -rf /etc/important")',
      'PY',
    ].join('\n');

    // §4.2: the sabotage must be present before the defence is credited.
    assert.match(cmd, /os\.system/, 'setup failed: no shell escape in the body');
    assert.match(cmd, /rm\s+-rf/, 'setup failed: no dangerous command in the body');
    assert.equal(bodyIsForeignSource("python3 - <<'PY'", 'import os\nos.system("rm -rf /etc/important")'),
      false, 'a body containing os.system was classified as inert source');

    assert.match(stripDataHeredocs(cmd), /rm\s+-rf/,
      'the body was stripped even though it can reach a shell');
    assert.equal(verdict(cmd), 'deny');
  });

  test('node heredoc that shells out with child_process is NOT treated as data', () => {
    const cmd = [
      "node - <<'JS'",
      "require('child_process').execSync('rm -rf /etc/important')",
      'JS',
    ].join('\n');
    assert.match(cmd, /child_process/, 'setup failed: no shell escape in the body');
    assert.match(cmd, /rm\s+-rf/, 'setup failed: no dangerous command in the body');
    assert.match(stripDataHeredocs(cmd), /rm\s+-rf/, 'the body was wrongly stripped');
    assert.equal(verdict(cmd), 'deny');
  });

  test('ruby backticks are a shell escape', () => {
    const body = 'puts `rm -rf /etc/important`';
    assert.match(body, /`/, 'setup failed: no backticks in the body');
    assert.equal(bodyIsForeignSource("ruby - <<'RB'", body), false);
  });

  test('perl qx is a shell escape', () => {
    const body = 'my $out = qx{rm -rf /etc/important};';
    assert.match(body, /qx\{/, 'setup failed: no qx in the body');
    assert.equal(bodyIsForeignSource("perl - <<'PL'", body), false);
  });

  test('the pipe-to-shell case is untouched — a SHELL on the opener always wins', () => {
    const cmd = ["cat <<'EOF' | bash", 'rm -rf /etc/important', 'EOF'].join('\n');
    assert.match(cmd, /\|\s*bash/, 'setup failed: the command does not pipe to a shell');
    assert.match(cmd, /rm\s+-rf/, 'setup failed: no dangerous command in the body');
    assert.equal(bodyIsForeignSource("cat <<'EOF' | bash", 'rm -rf /etc/important'), false);
    assert.match(stripDataHeredocs(cmd), /rm\s+-rf/, 'a piped-to-shell body was stripped');
    assert.equal(verdict(cmd), 'deny');
  });

  test('python piped into a shell is refused too — both tests must pass, not either', () => {
    // REWRITTEN 2026-09-08 (D-279), and the reason matters more than the rewrite.
    //
    // This used to call `bodyIsForeignSource("python3 -c 'x' <<'PY' | sh", 'rm -rf ...')`, because
    // that helper took the whole opener LINE and did its own shell detection with a regex. It now
    // takes a bare VERB: deciding shell-versus-foreign needs the lexer's command positions, and no
    // regex over a line can supply them — that is exactly how `cat > x.sh <<'EOF'` came to be read
    // as naming a shell.
    //
    // So the assertion moves to where the decision now lives, and it moves UP rather than sideways:
    // the old form tested a helper, this tests the real path end to end. The setup is asserted
    // first, per CLAUDE.md §4.2.
    const cmd = ["python3 - <<'PY' | sh", 'rm -rf /etc/important', 'PY'].join('\n');
    assert.match(cmd, /\|\s*sh\b/, 'setup failed: the command does not pipe to a shell');
    assert.match(cmd, /rm\s+-rf/, 'setup failed: no dangerous command in the body');
    assert.match(stripDataHeredocs(cmd), /rm\s+-rf/,
      'a body piped into a shell was stripped — the pipe-to-shell hole is open');
    assert.equal(verdict(cmd), 'deny');

    // And the old ARGUMENT SHAPE must now fail closed rather than silently answering about a
    // language it thinks it recognised. A verb has no whitespace and no metacharacters.
    assert.equal(bodyIsForeignSource("python3 -c 'x' <<'PY' | sh", 'rm -rf /etc/important'), false,
      'an opener line passed where a verb is expected must be refused, not parsed');
  });

  // --- ONLY NOW the case the change exists to fix ---------------------------------------------

  test('a python heredoc that only edits a file is data, and the words in it are not commands', () => {
    const cmd = [
      "python3 - <<'PY'",
      "p = 'RUNBOOK.md'",
      's = open(p).read()',
      's = s.replace("old", "Never run rm -rf / on a production box.")',
      "open(p, 'w').write(s)",
      'PY',
    ].join('\n');

    // The dangerous words really are in the fixture - otherwise this test proves nothing.
    assert.match(cmd, /rm\s+-rf/, 'setup failed: the prose does not contain the command');
    assert.doesNotMatch(cmd, /os\.system|subprocess|popen/,
      'setup failed: this fixture is supposed to have no shell escape');

    assert.doesNotMatch(stripDataHeredocs(cmd), /rm\s+-rf/,
      'the body was not stripped, so writing a runbook is still refused');
    assert.equal(verdict(cmd), 'allow');
  });

  test('the real shape that blocked this repository’s own edits', () => {
    // Reconstructed from a stored incident: a python heredoc rewriting a Markdown table whose
    // text names a release command. It fired against the engine as shipped.
    const cmd = [
      'cd /repo && python3 - <<\'PY\'',
      "import io",
      "s = io.open('DOGFOOD.md', encoding='utf8').read()",
      's = s.replace("| 12 | npm publish - a direct release |", "| 12 | corrected |")',
      "io.open('DOGFOOD.md', 'w', encoding='utf8').write(s)",
      'PY',
    ].join('\n');
    assert.match(cmd, /npm publish/, 'setup failed: the release command is not in the fixture');
    assert.equal(verdict(cmd), 'allow');
  });

  test('a plain data heredoc still works — the old behaviour is not regressed', () => {
    const cmd = ["cat > notes.md <<'EOF'", 'Never run rm -rf ~/ on a production box.', 'EOF'].join('\n');
    assert.match(cmd, /rm\s+-rf/, 'setup failed: no dangerous text in the body');
    assert.equal(verdict(cmd), 'allow');
  });

  test('an unterminated heredoc is still scanned in full', () => {
    const cmd = ["python3 - <<'PY'", 'x = "rm -rf /etc/important"'].join('\n');
    assert.match(cmd, /rm\s+-rf/, 'setup failed');
    assert.match(stripDataHeredocs(cmd), /rm\s+-rf/,
      'an unterminated heredoc was stripped, which means the parser guessed');
  });
});
