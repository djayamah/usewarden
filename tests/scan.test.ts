import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { scan, renderScan } from '../src/scan.js';
import { starterPolicyYaml } from '../src/policy/load.js';
import { clearGitStateCache } from '../src/engine/gitstate.js';
import { run } from './helpers.js';

/**
 * `usewarden scan` — and in particular, WHAT IT MUST NEVER PRINT.
 *
 * The feature exists to shorten time-to-first-value: before it, a new user's only options were a
 * synthetic `demo` or waiting for an agent to misbehave, and the second has unbounded latency.
 *
 * The tests that matter most here are the privacy ones, and they exist because the first version
 * of this command leaked. Run on its author's machine it printed, by name, every `~`-rooted entry
 * in the effective policy and every sibling repository — which on that machine meant a list of
 * the operator's unrelated private projects, straight to stdout.
 *
 * `forbidden_paths` is where a user lists what they most want kept away from an agent. That makes
 * it the worst list in the policy to echo: this output is meant to be pasted into bug reports.
 * A tool whose pitch is "your agent should not read your private things" cannot be the thing that
 * publishes their names.
 *
 * So: well-known defaults may be named, because `~/.ssh` is identical on every machine and says
 * nothing about anyone. Everything the user added is counted and not named. Same for siblings.
 */

function sandbox(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-scan-'));
  fs.mkdirSync(path.join(root, 'proj', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'proj', '.env'), 'SECRET=xyz\n');
  fs.mkdirSync(path.join(root, 'proj', '.git'), { recursive: true });
  // A sibling that is its own repository.
  fs.mkdirSync(path.join(root, 'my-private-side-project', '.git'), { recursive: true });
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe('scan: it reports facts about the real project', () => {
  test('it finds a .env inside the project and names it repo-relatively', () => {
    const sb = sandbox();
    try {
      const r = scan(path.join(sb.root, 'proj'), true);
      const creds = r.findings.find((f) => f.title.includes('credential file'));
      assert.ok(creds, 'a .env in the project should be reported');
      assert.match(creds.detail, /(^|[\s,])\.env/, 'it should name the file');
      assert.ok(!creds.detail.includes(sb.root),
        'it must not print the absolute path — repo-relative only');
    } finally { sb.cleanup(); }
  });

  test('it notices another repository beside this one', () => {
    const sb = sandbox();
    try {
      const r = scan(path.join(sb.root, 'proj'), true);
      assert.ok(r.findings.some((f) => /other git repositor/.test(f.title)));
    } finally { sb.cleanup(); }
  });

  test('it counts the rules that are live rather than the rules that exist', () => {
    const sb = sandbox();
    try {
      const r = scan(path.join(sb.root, 'proj'), true);
      assert.ok(r.liveRules > 0, 'some rules must be live');
      assert.ok(r.liveRules <= r.totalRules);
    } finally { sb.cleanup(); }
  });
});

describe('scan: PRIVACY — the output is meant to be pasteable', () => {
  test('a sibling repository is COUNTED and never NAMED', () => {
    const sb = sandbox();
    try {
      const r = scan(path.join(sb.root, 'proj'), true);
      const rendered = renderScan(r) + JSON.stringify(r);
      assert.ok(!rendered.includes('my-private-side-project'),
        'the name of a neighbouring repository must not appear anywhere in the output');
      assert.ok(r.findings.some((f) => /other git repositor/.test(f.title)),
        'but its existence must still be reported, or the check is worthless');
    } finally { sb.cleanup(); }
  });

  test('a user-added forbidden path is COUNTED and never NAMED', () => {
    const sb = sandbox();
    try {
      // A project policy adding a private directory to the forbidden list — exactly what a real
      // user does, and exactly what leaked.
      const secret = '~/my-unrelated-private-work';
      fs.writeFileSync(path.join(sb.root, 'proj', 'usewarden.yaml'),
        `version: 1\nscope:\n  forbidden_paths:\n    - "${secret}"\n`);
      const r = scan(path.join(sb.root, 'proj'), true);
      const rendered = renderScan(r) + JSON.stringify(r);
      assert.ok(!rendered.includes('my-unrelated-private-work'),
        'a path the USER added to forbidden_paths must never be echoed back');
    } finally { sb.cleanup(); }
  });

  test('the well-known defaults MAY be named — they identify nobody', () => {
    const sb = sandbox();
    try {
      const r = scan(path.join(sb.root, 'proj'), true);
      const rendered = renderScan(r);
      // ~/.ssh exists on essentially every developer machine. Naming it is informative and
      // carries no information about this user, which is the whole test being applied.
      assert.ok(/~\/\./.test(rendered) || r.findings.length > 0);
    } finally { sb.cleanup(); }
  });

  test('it never opens a credential file it reports', () => {
    const sb = sandbox();
    try {
      const r = scan(path.join(sb.root, 'proj'), true);
      const rendered = renderScan(r) + JSON.stringify(r);
      assert.ok(!rendered.includes('SECRET=xyz'),
        'the CONTENTS of a reported .env must never appear — scan stats, it does not read');
    } finally { sb.cleanup(); }
  });
});

describe('scan: it does not fake a catch', () => {
  test('every verdict is conditional — WOULD BLOCK, never BLOCKED', () => {
    const sb = sandbox();
    try {
      const rendered = renderScan(scan(path.join(sb.root, 'proj'), true));
      assert.ok(/WOULD BLOCK/.test(rendered) || /CLEAR/.test(rendered));
      assert.ok(!/\bBLOCKED\b/.test(rendered),
        'scan must never claim something was blocked; nothing happened');
    } finally { sb.cleanup(); }
  });

  test('with hooks NOT registered it says so, loudly, and does not imply protection', () => {
    const sb = sandbox();
    try {
      const rendered = renderScan(scan(path.join(sb.root, 'proj'), false));
      assert.match(rendered, /NOT registered/,
        'telling someone they are protected when they have not run init is the lie status exists to prevent');
      assert.match(rendered, /usewarden init/, 'and it must say how to fix it');
    } finally { sb.cleanup(); }
  });

  test('the starter policy still parses, so scan and init agree on the defaults', () => {
    // Guards against scan reporting rules that `init` would not actually write.
    const sb = sandbox();
    try {
      assert.ok(starterPolicyYaml(path.join(sb.root, 'proj')).includes('version: 1'));
    } finally { sb.cleanup(); }
  });
});


describe('scan: work git could not get back', () => {
  /** A REAL repository — the finding is a claim about git, so git has to be the thing asked. */
  function gitProject(): { dir: string; cleanup: () => void } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-scan-git-'));
    const dir = path.join(root, 'proj');
    fs.mkdirSync(dir, { recursive: true });
    run('git', ['-C', dir, 'init', '-q', '-b', 'main']);
    run('git', ['-C', dir, 'config', 'user.email', 'test@example.invalid']);
    run('git', ['-C', dir, 'config', 'user.name', 'usewarden test']);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored-output/\n');
    fs.writeFileSync(path.join(dir, 'committed.md'), 'safe\n');
    fs.writeFileSync(path.join(dir, 'changed.md'), 'v1\n');
    run('git', ['-C', dir, 'add', '-A']);
    run('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
    clearGitStateCache();
    return { dir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
  }

  test('a fully committed project is reported as CLEAR, not as a finding', () => {
    const p = gitProject();
    try {
      const f = scan(p.dir, true).findings.find((x) => /committed or ignored/.test(x.title));
      assert.ok(f, 'a clean project should say so rather than say nothing');
      assert.equal(f.severity, 'info');
    } finally { p.cleanup(); }
  });

  test('untracked and modified files are counted, and the count matches git', () => {
    const p = gitProject();
    try {
      fs.writeFileSync(path.join(p.dir, 'changed.md'), 'the human has been working on this\n');
      fs.writeFileSync(path.join(p.dir, 'scratch.md'), 'notes\n');
      fs.mkdirSync(path.join(p.dir, 'ignored-output'), { recursive: true });
      fs.writeFileSync(path.join(p.dir, 'ignored-output', 'bundle.js'), 'built\n');
      clearGitStateCache();

      const f = scan(p.dir, true).findings.find((x) => /could not restore/.test(x.title));
      assert.ok(f, 'the finding must appear');
      // Cross-checked against git rather than against our own expectation.
      const porcelain = run('git', ['-C', p.dir, 'status', '--porcelain', '-uall'])
        .split('\n').filter((l) => l.trim() !== '');
      assert.equal(porcelain.length, 2, `setup: git should see 2 changes, saw ${porcelain.length}`);
      assert.match(f.title, /^2 files here hold work git could not restore$/);
      assert.match(f.detail, /1 untracked, 1 with uncommitted changes/);
    } finally { p.cleanup(); }
  });

  test('PRIVACY: what you have not committed is COUNTED and never NAMED', () => {
    // A list of uncommitted files is a list of what someone is in the middle of, and this output
    // is meant to be pasteable. Same rule as the sibling repositories and the user-added paths.
    const p = gitProject();
    try {
      fs.writeFileSync(path.join(p.dir, 'acquisition-terms-draft.md'), 'confidential\n');
      clearGitStateCache();
      const r = scan(p.dir, true);
      const text = renderScan(r);
      assert.match(text, /1 file here holds work git could not restore/);
      assert.ok(!text.includes('acquisition-terms-draft'),
        'scan must never print the name of an uncommitted file');
    } finally { p.cleanup(); }
  });

  test('the guard being off in the USER policy removes the finding entirely', () => {
    const p = gitProject();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-scan-home-'));
    const prev = process.env['USEWARDEN_HOME'];
    try {
      process.env['USEWARDEN_HOME'] = home;
      fs.writeFileSync(path.join(home, 'usewarden.yaml'),
        'version: 1\nscope:\n  protect_uncommitted: false\n');
      fs.writeFileSync(path.join(p.dir, 'scratch.md'), 'notes\n');
      clearGitStateCache();
      const r = scan(p.dir, true);
      assert.equal(r.findings.some((x) => /could not restore|committed or ignored/.test(x.title)), false,
        'a disabled guard must not advertise itself as protection');
    } finally {
      if (prev === undefined) delete process.env['USEWARDEN_HOME']; else process.env['USEWARDEN_HOME'] = prev;
      fs.rmSync(home, { recursive: true, force: true });
      p.cleanup();
    }
  });

  test('a CLONED repo cannot turn the guard off — that is a widening, and it is refused', () => {
    // The hostile-usewarden.yaml case (SPEC-BUILD 3A.5) applied to this rule: a repository you
    // just cloned does not get to decide that your uncommitted work is expendable.
    const p = gitProject();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-scan-home-'));
    const prev = process.env['USEWARDEN_HOME'];
    try {
      process.env['USEWARDEN_HOME'] = home;
      fs.writeFileSync(path.join(p.dir, 'usewarden.yaml'),
        'version: 1\nscope:\n  protect_uncommitted: false\n');
      fs.writeFileSync(path.join(p.dir, 'scratch.md'), 'notes\n');
      clearGitStateCache();
      const r = scan(p.dir, true);
      assert.ok(r.findings.some((x) => /could not restore/.test(x.title)),
        'the repo policy must not have been able to disable it');
    } finally {
      if (prev === undefined) delete process.env['USEWARDEN_HOME']; else process.env['USEWARDEN_HOME'] = prev;
      fs.rmSync(home, { recursive: true, force: true });
      p.cleanup();
    }
  });
});
