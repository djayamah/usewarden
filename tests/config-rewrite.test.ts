import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * WHEN THE AGENT REWRITES ITS OWN SETTINGS FILE AND DROPS USEWARDEN'S TAG.
 *
 * `_usewarden: true` is usewarden's own bookkeeping. It is NOT part of Claude Code's documented
 * hook schema, and Claude Code rewrites `~/.claude/settings.json` whenever its own settings
 * change. On the author's machine it did exactly that on 2026-08-24: it kept `matcher`, `type`,
 * `command`, `args` and `timeout` byte for byte, and dropped `_usewarden` from all fourteen
 * places. Usewarden was still registered, still firing, and still recording 4,776 events.
 *
 * Identity by label meant it could not see itself, and everything downstream followed:
 *
 *   status     UNPROTECTED, in the TAMPERED wording ("entries are GONE") - a false negative on
 *              the one question this product exists to answer.
 *   init       which is what that message tells the user to run, added a SECOND copy of every
 *              hook. Every agent event then spawned two usewarden processes, and a third after
 *              the next rewrite, without bound.
 *   uninstall  "No usewarden hook entries found; nothing to remove" while seven live
 *              registrations stayed in the file. The byte-identical-restore promise, silently
 *              broken.
 *
 * The fix moves identity onto the argv - `hook <agent> <kind>` is usewarden's own CLI contract,
 * and a rewriter that dropped THAT would break the hook itself - and makes the integrity hash
 * ignore the tag so a dropped label is no longer indistinguishable from a swapped payload.
 *
 * Every test here asserts THE SABOTAGE LANDED before asserting the defence: that the tag is
 * really gone and the hooks are really still there. A version of this file that only checked the
 * verdict would pass just as happily against a config the strip never touched.
 */
describe('an agent rewrite that drops usewarden\'s tag', () => {
  const CLI = path.resolve('dist/src/cli.js');

  interface Box { home: string; uw: string; proj: string; cfg: string; cleanup(): void }

  function box(): Box {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usewarden-rewrite-'));
    const home = path.join(root, 'home');
    const uw = path.join(root, 'uw');
    const proj = path.join(root, 'proj');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(uw, { recursive: true });
    fs.mkdirSync(proj, { recursive: true });
    return {
      home, uw, proj,
      cfg: path.join(home, '.claude', 'settings.json'),
      cleanup() { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } },
    };
  }

  /**
   * `status` exits non-zero when it is not PROTECTED - deliberately, so a CI check can gate on it
   * (D-012's lesson: a guard that is silently off must not look like success). So stdout is what
   * matters here and a non-zero exit is a normal outcome, not a failure to run.
   */
  function run(b: Box, ...args: string[]): string {
    try {
      return execFileSync(process.execPath, [CLI, ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: b.proj,
        env: { ...process.env, HOME: b.home, USEWARDEN_HOME: b.uw, NO_COLOR: '1' },
      });
    } catch (e) {
      const out = (e as { stdout?: string }).stdout;
      if (typeof out === 'string') return out;
      throw e;
    }
  }

  const stripTag = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stripTag);
    if (typeof v !== 'object' || v === null) return v;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === '_usewarden') continue;
      out[k] = stripTag(val);
    }
    return out;
  };

  /** Install, then reproduce the rewrite: drop the tag and change NOTHING else. */
  function installThenStrip(b: Box): { before: unknown; after: unknown } {
    run(b, 'init', '--yes');
    const before = JSON.parse(fs.readFileSync(b.cfg, 'utf8')) as unknown;

    // PRECONDITION 1: init really did write the tag. If it stopped, this whole file is vacuous.
    assert.ok(JSON.stringify(before).includes('"_usewarden"'),
      'setup failed: init did not write the _usewarden tag, so there is nothing to strip');

    const after = stripTag(before);
    fs.writeFileSync(b.cfg, JSON.stringify(after, null, 2));

    // PRECONDITION 2: the strip landed, and it changed ONLY the tag.
    const reread = JSON.parse(fs.readFileSync(b.cfg, 'utf8')) as unknown;
    assert.ok(!JSON.stringify(reread).includes('"_usewarden"'),
      'setup failed: the tag survived the strip');
    assert.deepEqual(reread, stripTag(before),
      'setup failed: the strip changed something other than the tag');

    // PRECONDITION 3: the hooks are STILL REGISTERED. That is the entire point - usewarden is
    // running. A test that passed because the config was emptied would prove nothing.
    const hooks = (reread as { hooks?: Record<string, unknown[]> }).hooks ?? {};
    const invocations = Object.values(hooks)
      .flatMap((arr) => (Array.isArray(arr) ? arr : []))
      .flatMap((m) => ((m as { hooks?: unknown[] }).hooks ?? []));
    assert.ok(invocations.length >= 7,
      `setup failed: expected the hooks to survive the strip, found ${invocations.length}`);

    return { before, after };
  }

  test('status still reports PROTECTED - it recognises itself by what it runs', () => {
    const b = box();
    try {
      installThenStrip(b);
      const out = run(b, 'status');
      assert.match(out, /PROTECTED/,
        'usewarden could not see its own registration after the tag was dropped');
      assert.doesNotMatch(out, /UNPROTECTED/, 'reported UNPROTECTED while it was in fact running');
      assert.doesNotMatch(out, /are GONE/,
        'used the TAMPERED wording for a config it fully owns and that still works');
    } finally { b.cleanup(); }
  });

  test('init stays idempotent - it does not add a second copy of every hook', () => {
    const b = box();
    try {
      installThenStrip(b);
      const count = (): number => {
        const d = JSON.parse(fs.readFileSync(b.cfg, 'utf8')) as { hooks: Record<string, unknown[]> };
        return Object.values(d.hooks).flatMap((a) => a)
          .reduce<number>((n, m) => n + ((m as { hooks?: unknown[] }).hooks ?? []).length, 0);
      };
      const before = count();
      run(b, 'init', '--yes');
      assert.equal(count(), before,
        `init duplicated the hooks: ${before} -> ${count()}. Every agent event would fire usewarden twice.`);
    } finally { b.cleanup(); }
  });

  test('uninstall actually removes them, rather than reporting nothing to do', () => {
    const b = box();
    try {
      installThenStrip(b);
      run(b, 'uninstall', '--yes');
      const left = fs.readFileSync(b.cfg, 'utf8');
      assert.doesNotMatch(left, /cli\.js/,
        'uninstall left live usewarden registrations behind while reporting success');
    } finally { b.cleanup(); }
  });

  /**
   * The other half, and the reason the tag is still honoured: a REAL tamper must still be caught.
   * Broadening what counts as "ours" must not narrow what counts as "changed".
   */
  for (const [name, mutate] of [
    ['payload swapped, tag kept', (d: any): void => {
      d.hooks.PreToolUse[0].hooks[0].args = ['/tmp/evil.js', 'hook', 'claude', 'pre_tool'];
    }],
    ['payload swapped and tag dropped', (d: any): void => {
      d.hooks.PreToolUse[0].hooks[0].args = ['/tmp/evil.js', 'hook', 'claude', 'pre_tool'];
    }],
    ['a whole event deleted', (d: any): void => { delete d.hooks.PreToolUse; }],
  ] as [string, (d: any) => void][]) {
    test(`still reports TAMPERED when: ${name}`, () => {
      const b = box();
      try {
        run(b, 'init', '--yes');
        const d = JSON.parse(fs.readFileSync(b.cfg, 'utf8')) as any;
        const pristine = JSON.stringify(d);
        mutate(d);
        const mutated = name.includes('tag dropped') ? stripTag(d) : d;
        fs.writeFileSync(b.cfg, JSON.stringify(mutated, null, 2));
        // PRECONDITION: the mutation actually changed the file.
        assert.notEqual(JSON.stringify(JSON.parse(fs.readFileSync(b.cfg, 'utf8'))), pristine,
          'setup failed: the tamper did not change the config');
        assert.match(run(b, 'status'), /TAMPERED/,
          'a genuine tamper went unreported - the fix widened recognition too far');
      } finally { b.cleanup(); }
    });
  }
});
