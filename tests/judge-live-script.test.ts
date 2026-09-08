import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'judge-live.sh');

/**
 * `scripts/judge-live.sh` handles a real API key, which makes it the highest-consequence file in
 * the repository under CLAUDE.md section 2: never echo, log, or write a key, and redact BY
 * CONSTRUCTION rather than by remembering to.
 *
 * Every test here runs against a Keychain service that does not exist, so the suite never touches
 * the real credential and never makes a network call. What that buys is the important property:
 * the failure paths are the ones that leak, and these are the failure paths.
 */

/**
 * Realistic key SHAPES. None of these is a real credential, and each one now SAYS SO in its own
 * body rather than relying on a reader to notice the zeros. The pre-public scanner classifies a
 * credential-shaped string as synthetic when it carries a marker like NOT-A-REAL-KEY or has
 * almost no entropy; a fixture that announces itself is the honest way to satisfy that, and the
 * alternative - teaching the scanner to ignore this file - would blind it to a real key landing
 * here later. Every value below still matches the detection regex it exercises.
 */
const FAKE_KEYS = [
  'AIzaSyD-0000000000000000000000000000000',
  'AQ.NOT-A-REAL-KEY-000000000000000000000000000000',
  'sk-ant-api03-0000000000000000000000000000',
  'sk-proj-00000000000000000000000000000000',
  'ghp_000000000000000000000000000000000000',
  'github_pat_00000000000000000000000000000000',
  'npm_0000000000000000000000000000000000',
  'AKIA0000000000000000',
  'xoxb-0000000000-0000000000',
];

/** Anything that still looks like a credential after scrubbing. */
function keyShaped(s: string): string[] {
  const patterns = [
    /AIza[0-9A-Za-z_-]{30,}/g,
    /AQ\.[A-Za-z0-9_-]{20,}/g,
    /sk-ant-[A-Za-z0-9_-]{8,}/g,
    /sk-(proj-)?[A-Za-z0-9_-]{16,}/g,
    /gh[pousr]_[A-Za-z0-9]{16,}/g,
    /github_pat_[A-Za-z0-9_]{20,}/g,
    /npm_[A-Za-z0-9]{20,}/g,
    /AKIA[0-9A-Z]{16}/g,
    /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  ];
  return patterns.flatMap((re) => [...s.matchAll(re)].map((m) => m[0]));
}

function run(args: string[], env: Record<string, string> = {}, input?: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(SCRIPT, args, {
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
    ...(input !== undefined ? { input } : {}),
    env: {
      ...process.env,
      // Point at a service that cannot exist, so nothing here can reach the real credential.
      USEWARDEN_KEYCHAIN_SERVICE: 'usewarden-test-nonexistent-do-not-create',
      ...env,
    },
  });
  assert.equal(r.signal, null, 'the script had to be killed - it hung');
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('judge-live.sh: the key cannot reach stdout or stderr', () => {
  test('the script exists and is executable', () => {
    assert.equal(fs.existsSync(SCRIPT), true, 'setup failed - no script');
    if (process.platform !== 'win32') {
      assert.equal((fs.statSync(SCRIPT).mode & 0o111) !== 0, true, 'the script is not executable');
    }
  });

  /**
   * `security` is the macOS Keychain binary and does not exist on Linux, so the failure this
   * script hits first differs by platform. What must NOT differ is the contract: exit 3, loud,
   * says that nothing ran, and leaks nothing key-shaped. Those are asserted everywhere; only the
   * message text is platform-specific, and each platform's own message is asserted rather than
   * skipped. The old version asserted the macOS message unconditionally and failed on all three
   * Linux legs of the matrix from the day the workflow was added.
   */
  const hasKeychain = spawnSync('command', ['-v', 'security'], { shell: true }).status === 0;

  test('a setup failure is loud, runs nothing, and leaks nothing - on either platform', () => {
    const r = run([]);
    assert.notEqual(r.status, 0, 'a missing key must not be a success');
    assert.equal(r.status, 3, 'setup failures use exit 3, distinct from a judge FAIL (1)');
    assert.match(r.stderr, /Nothing was run and no request was made/,
      'the message must say that nothing happened, not merely that something went wrong');
    assert.deepEqual(keyShaped(r.stdout + r.stderr), [], 'something key-shaped reached the output');

    if (hasKeychain) {
      assert.match(r.stderr, /FAILED - no Keychain entry/);
      assert.match(r.stderr, /security add-generic-password/,
        'a failure that does not say how to fix it is a trap');
    } else {
      assert.match(r.stderr, /the 'security' command is not on PATH/);
      assert.match(r.stderr, /judge-check/,
        'a failure that does not say how to fix it is a trap - here, the portable alternative');
    }
  });

  test('an unknown provider and a missing account fail loudly on every platform', () => {
    // Both of these are argument validation and reach no Keychain, which is why the script checks
    // them before it looks for `security` - behind it they were unreachable off macOS.
    const unknown = run([], { USEWARDEN_JUDGE_PROVIDER: 'not-a-provider' });
    assert.equal(unknown.status, 3);
    assert.match(unknown.stderr, /unknown provider/);

    const noAccount = run([], { USER: '', USEWARDEN_KEYCHAIN_ACCOUNT: '' });
    assert.equal(noAccount.status, 3);
    assert.match(noAccount.stderr, /no Keychain account name/);

    for (const r of [unknown, noAccount]) {
      assert.deepEqual(keyShaped(r.stdout + r.stderr), []);
    }
  });

  /**
   * The scrubber is the last line of defence and the only one that works on output the script
   * did not write - a vendor error body, a stack trace, a `security` diagnostic. It redacts by
   * SHAPE, so it needs no knowledge of the value and cannot be defeated by the value changing.
   */
  test('the scrubber redacts every credential shape it could plausibly meet', () => {
    for (const fake of FAKE_KEYS) {
      const noise = `error: request failed with credential ${fake} in the body\n`;
      // sabotage landed: the fake key really is in the input.
      assert.equal(keyShaped(noise).length > 0, true, `setup failed - ${fake} is not key-shaped`);

      const r = run(['--scrub-stdin'], {}, noise);
      assert.equal(r.status, 0);
      assert.deepEqual(keyShaped(r.stdout), [], `${fake} survived scrubbing: ${r.stdout}`);
      assert.match(r.stdout, /\[REDACTED/, 'the redaction must be visible, not a silent deletion');
    }
  });

  test('the scrubber leaves ordinary output alone', () => {
    const ordinary = 'provider gemini / gemini-3.7-flash\ntokens in 512, out 41\ncost $0.000717\nPASS\n';
    const r = run(['--scrub-stdin'], {}, ordinary);
    assert.equal(r.stdout, ordinary, 'a scrubber that mangles normal output gets removed');
  });

  test('a multi-line body with a key on one line is fully scrubbed', () => {
    const body = ['{', '  "error": {', `    "message": "key ${FAKE_KEYS[0]} is invalid"`, '  }', '}'].join('\n') + '\n';
    const r = run(['--scrub-stdin'], {}, body);
    assert.deepEqual(keyShaped(r.stdout), []);
  });
});

describe('judge-live.sh: the key never becomes a variable, an argument, or a file', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');

  test('it never traces', () => {
    assert.equal(/^\s*set\s+-[a-z]*x/m.test(src), false,
      'set -x would print the command substitution that reads the key');
    assert.equal(/\bPS4\b/.test(src), false);
  });

  test('it never exports a key, and never assigns one to a shell variable', () => {
    assert.equal(/export\s+(GEMINI|ANTHROPIC|OPENAI)_API_KEY/.test(src), false,
      'an export outlives the command');
    // A bare `KEY=$(security ...)` on its own line would be a variable that survives the line.
    // The permitted form is an assignment PREFIX: the same text followed by a continuation and a
    // command, which bash scopes to that one command.
    for (const m of src.matchAll(/^\s*((?:GEMINI|ANTHROPIC|OPENAI)_API_KEY=)(.*)$/gm)) {
      assert.match(m[2]!, /\\\s*$/,
        `"${m[0]!.trim()}" is a standalone assignment, not a one-command prefix`);
    }
  });

  test('the key is never passed as an argument', () => {
    assert.equal(/\benv\s+["']?(GEMINI|ANTHROPIC|OPENAI)_API_KEY=/.test(src), false,
      'env NAME=value puts the key in argv, where ps can read it');
    assert.equal(/-H\s+["'][^"']*(api[_-]?key|authorization)/i.test(src), false,
      'a curl -H header would put the key in argv');
  });

  test('the key is never written anywhere', () => {
    // Only a `-w` invocation actually reads the VALUE. Redirecting the existence probe (which
    // prints attributes, never the password) to /dev/null is how you throw output away, not how
    // you write a key down - flagging it would be a false positive that trains people to loosen
    // the check.
    for (const line of [...src.matchAll(/^[^\n#]*security find-generic-password -w[^\n]*/gm)].map((m) => m[0])) {
      const redirect = /(^|[^0-9&>])>\s*(\S+)/.exec(line);
      assert.ok(redirect === null || redirect[2] === '/dev/null',
        `the key value is redirected somewhere: ${line.trim()}`);
    }
    assert.equal(/\bmktemp\b/.test(src), false, 'this script needs no temp file, and a temp file is a place a key can land');
    assert.equal(/\btee\b/.test(src), false);
  });

  test('the script only ever learns the key LENGTH', () => {
    // Every `security ... -w` must be consumed by exactly one of: a length measurement, or a
    // one-command assignment prefix.
    const reads = [...src.matchAll(/^[^\n#]*security find-generic-password -w[^\n]*/gm)].map((m) => m[0]);
    assert.ok(reads.length >= 2, 'setup failed - expected the length probe and the injections');
    for (const line of reads) {
      const isLengthProbe = /wc -c/.test(line) || /KEY_LEN=/.test(line);
      const isInjection = /^\s*(GEMINI|ANTHROPIC|OPENAI)_API_KEY="\$\(security/.test(line);
      assert.ok(isLengthProbe || isInjection, `unaccounted read of the key: ${line.trim()}`);
    }
  });

  test('both child streams are piped through the scrubber', () => {
    const invocations = [...src.matchAll(/node "\$CLI" judge-check[^\n]*/g)].map((m) => m[0]);
    assert.ok(invocations.length >= 1, 'setup failed - found no CLI invocation');
    for (const inv of invocations) {
      assert.match(inv, /2>&1 \| scrub/, `an invocation does not scrub both streams: ${inv}`);
    }
  });

  test('the enforced ceilings are present on every invocation', () => {
    const invocations = [...src.matchAll(/(GEMINI|ANTHROPIC|OPENAI)_API_KEY="\$\(security[\s\S]{0,400}?judge-check[^\n]*/g)]
      .map((m) => m[0]);
    assert.ok(invocations.length >= 1, 'setup failed - found no injection');
    for (const inv of invocations) {
      assert.match(inv, /USEWARDEN_JUDGE_NO_LOCAL=1/, 'without this the local CLI is used and nothing metered is proved');
      assert.match(inv, /USEWARDEN_JUDGE_MAX_USD=0\.25/, 'the spend ceiling must be on every invocation');
    }
  });
});
