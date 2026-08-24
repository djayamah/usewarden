import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { gitFileState, isIgnored, compileIgnoreLine, resolveGitDir, parseGitIndex, clearGitStateCache }
  from '../src/engine/gitstate.js';
import { tempDir, run } from './helpers.js';

/**
 * THE ONLY HONEST TEST FOR THIS MODULE IS A DIFFERENTIAL ONE.
 *
 * `gitstate.ts` reimplements a slice of git — index parsing and ignore matching — because
 * THREAT-MODEL T-05 forbids putting an agent-supplied path on a command line. A reimplementation
 * asserted against its author's expectations is asserted against the wrong thing, which is the
 * lesson `tests/policy-coverage.test.ts` already records about the sabotage suite.
 *
 * So the central test builds real repositories, asks REAL GIT what it thinks with
 * `git status --porcelain --ignored -uall`, and requires our answer to equal git's for every path.
 * Git is the oracle; we are the thing under test.
 */

const repos: string[] = [];
after(() => { for (const r of repos) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ } } });

function repo(): string {
  const dir = fs.mkdtempSync(path.join(tempDir('usewarden-git-'), 'r'));
  repos.push(dir);
  run('git', ['-C', dir, 'init', '-q', '-b', 'main']);
  run('git', ['-C', dir, 'config', 'user.email', 'test@example.invalid']);
  run('git', ['-C', dir, 'config', 'user.name', 'usewarden test']);
  return dir;
}
function write(dir: string, rel: string, body: string): string {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}
function commitAll(dir: string, msg = 'c'): void {
  run('git', ['-C', dir, 'add', '-A']);
  run('git', ['-C', dir, 'commit', '-q', '-m', msg]);
}

/**
 * What git says about one path, reduced to this module's vocabulary.
 *
 * The porcelain XY code's SECOND column is worktree-vs-index, which is exactly the question
 * gitFileState answers. A path git does not list at all is clean.
 */
function gitSays(dir: string, rel: string): string {
  const out = run('git', ['-C', dir, 'status', '--porcelain', '--ignored', '-uall']);
  for (const line of out.split('\n')) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    const name = line.slice(3).replace(/^"|"$/g, '');
    if (name !== rel && name !== `${rel}/` && !rel.startsWith(name.replace(/\/$/, '') + '/')) continue;
    if (code === '??') return 'untracked';
    if (code === '!!') return 'ignored';
    if (name !== rel) continue;              // an ancestor entry only settles ?? and !!
    return code[1] === ' ' ? 'clean' : 'modified';
  }
  return 'clean';
}

describe('gitstate agrees with real git', () => {
  test('every state, cross-checked against git status --porcelain --ignored', () => {
    const dir = repo();
    write(dir, '.gitignore', 'dist/\n*.log\nbuild/out.js\n!keep.log\n');
    write(dir, 'committed.md', 'original\n');
    write(dir, 'src/app.ts', 'export const a = 1;\n');
    write(dir, 'nested/deep/file.txt', 'x\n');
    commitAll(dir);

    // Now produce one of each state.
    write(dir, 'src/app.ts', 'export const a = 2;\n');   // tracked + modified
    write(dir, 'scratch.md', 'the humans notes\n');       // untracked
    write(dir, 'dist/bundle.js', 'built\n');              // ignored by directory rule
    write(dir, 'debug.log', 'noise\n');                   // ignored by extension rule
    write(dir, 'keep.log', 'kept\n');                     // un-ignored by negation
    write(dir, 'build/out.js', 'built\n');                // ignored by an anchored path rule
    clearGitStateCache();

    const cases = ['committed.md', 'src/app.ts', 'scratch.md', 'dist/bundle.js',
      'debug.log', 'keep.log', 'build/out.js', 'nested/deep/file.txt'];

    const mismatches: string[] = [];
    for (const rel of cases) {
      const ours = gitFileState(path.join(dir, rel), dir);
      const theirs = gitSays(dir, rel);
      if (ours !== theirs) mismatches.push(`${rel}: usewarden says ${ours}, git says ${theirs}`);
    }
    assert.deepEqual(mismatches, [], `disagreed with git:\n  - ${mismatches.join('\n  - ')}`);
  });

  test('a stat change with no content change is CLEAN, not modified', () => {
    // The most ordinary action there is — a rebuild, a checkout, a `touch` — must not be reported
    // as lost work. Stat alone would call this modified; the object id settles it.
    const dir = repo();
    const f = write(dir, 'a.txt', 'same bytes\n');
    commitAll(dir);
    const later = new Date(Date.now() + 10_000);
    fs.utimesSync(f, later, later);
    clearGitStateCache();
    assert.equal(gitFileState(f, dir), 'clean');
    assert.equal(gitSays(dir, 'a.txt'), 'clean');
  });

  test('staged-but-uncommitted content is CLEAN — git has the bytes in its object store', () => {
    const dir = repo();
    write(dir, 'a.txt', 'v1\n');
    commitAll(dir);
    write(dir, 'a.txt', 'v2\n');
    run('git', ['-C', dir, 'add', 'a.txt']);
    clearGitStateCache();
    assert.equal(gitFileState(path.join(dir, 'a.txt'), dir), 'clean');
  });

  test('a file that does not exist is absent, and a directory is not a file', () => {
    const dir = repo();
    write(dir, 'a.txt', 'x\n');
    commitAll(dir);
    clearGitStateCache();
    assert.equal(gitFileState(path.join(dir, 'nope.txt'), dir), 'absent');
    assert.equal(gitFileState(path.join(dir, 'sub', 'nope.txt'), dir), 'absent');
    fs.mkdirSync(path.join(dir, 'sub'));
    assert.equal(gitFileState(path.join(dir, 'sub'), dir), 'outside');
  });

  test('a path outside the repository is not this module’s business', () => {
    const dir = repo();
    write(dir, 'a.txt', 'x\n');
    commitAll(dir);
    clearGitStateCache();
    assert.equal(gitFileState(path.join(dir, '..', 'elsewhere.txt'), dir), 'outside');
  });

  test('an EMPTY repository with no commits: tracked-ness still reads correctly', () => {
    const dir = repo();
    write(dir, 'a.txt', 'x\n');
    clearGitStateCache();
    assert.equal(gitFileState(path.join(dir, 'a.txt'), dir), 'untracked');
    run('git', ['-C', dir, 'add', 'a.txt']);
    clearGitStateCache();
    assert.equal(gitFileState(path.join(dir, 'a.txt'), dir), 'clean');
  });

  test('long paths, spaces and non-ASCII names still parse', () => {
    // Entry padding is computed from the name length, so a mis-sized entry desynchronises every
    // entry AFTER it and calls tracked files untracked - the direction that fires on ordinary work.
    // Names of many different lengths in one index is what exercises all eight padding cases.
    //
    // The 12-bit name-length field saturating at 0x0fff is handled in the parser and is NOT
    // reachable from a test on this platform: it needs a path over 4095 bytes and macOS caps a
    // path at 1024. Stated rather than asserted, because a test that cannot run is not a pass.
    const dir = repo();
    const deep = Array.from({ length: 12 }, (_, i) => `directory-with-a-long-name-${i}`).join('/');
    write(dir, `${deep}/file.txt`, 'x\n');
    write(dir, 'a file with spaces.txt', 'x\n');
    write(dir, 'ünïcode-ファイル.txt', 'x\n');
    for (let i = 1; i <= 16; i++) write(dir, `pad/${'n'.repeat(i)}.txt`, 'x\n');
    commitAll(dir);
    clearGitStateCache();

    const tracked = run('git', ['-C', dir, 'ls-files', '-z']).split('\0').filter((x) => x !== '');
    assert.equal(tracked.length, 19, `setup: expected the full fixture in the index, got ${tracked.length}`);
    const wrong = tracked.filter((rel) => gitFileState(path.join(dir, rel), dir) !== 'clean');
    assert.deepEqual(wrong, [], `these tracked files were misread:\n  - ${wrong.join('\n  - ')}`);
  });

  test('index parsing survives many entries and reports every one of them', () => {
    const dir = repo();
    for (let i = 0; i < 200; i++) write(dir, `f/${i}-${'n'.repeat(i % 40)}.txt`, `${i}\n`);
    commitAll(dir);
    clearGitStateCache();
    const gitDir = resolveGitDir(dir)!;
    const idx = parseGitIndex(gitDir);
    assert.ok(idx, 'the index must parse');
    assert.equal(idx.size, 200);
    for (let i = 0; i < 200; i++) {
      assert.equal(gitFileState(path.join(dir, `f/${i}-${'n'.repeat(i % 40)}.txt`), dir), 'clean',
        `entry ${i} was misread`);
    }
  });

  test('the cache notices a file changing under it', () => {
    const dir = repo();
    const f = write(dir, 'a.txt', 'v1\n');
    commitAll(dir);
    assert.equal(gitFileState(f, dir), 'clean');
    fs.writeFileSync(f, 'v2 different length\n');
    // No clearGitStateCache() here on purpose: the file cache key is the INDEX, and the index has
    // not changed, so this proves the working-tree side is re-read every call.
    assert.equal(gitFileState(f, dir), 'modified');
  });

  test('no repository at all is UNKNOWN, and unknown never fires', () => {
    const dir = fs.mkdtempSync(path.join(tempDir('usewarden-nogit-'), 'r'));
    repos.push(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
    clearGitStateCache();
    assert.equal(gitFileState(path.join(dir, 'a.txt'), dir), 'unknown');
  });

  test('an unreadable or foreign index is UNKNOWN rather than guessed at', () => {
    const dir = repo();
    write(dir, 'a.txt', 'x\n');
    commitAll(dir);
    fs.writeFileSync(path.join(dir, '.git', 'index'), 'NOTANINDEX');
    clearGitStateCache();
    assert.equal(gitFileState(path.join(dir, 'a.txt'), dir), 'unknown');
  });
});

describe('gitignore matching', () => {
  const M = (pattern: string, rel: string, dirPrefix = ''): boolean => {
    const r = compileIgnoreLine(pattern, dirPrefix);
    return r !== null && r.re.test(rel);
  };

  test('basename patterns match at any depth; anchored ones do not', () => {
    assert.equal(M('*.log', 'a.log'), true);
    assert.equal(M('*.log', 'deep/nested/a.log'), true);
    assert.equal(M('/root.log', 'root.log'), true);
    assert.equal(M('/root.log', 'deep/root.log'), false);
    assert.equal(M('build/out.js', 'build/out.js'), true);
    assert.equal(M('build/out.js', 'deep/build/out.js'), false);
  });

  test('** crosses directories and * does not', () => {
    assert.equal(M('src/**/gen.ts', 'src/a/b/gen.ts'), true);
    assert.equal(M('src/**/gen.ts', 'src/gen.ts'), true);
    assert.equal(M('src/*/gen.ts', 'src/a/b/gen.ts'), false);
    assert.equal(M('src/*/gen.ts', 'src/a/gen.ts'), true);
  });

  test('comments, blanks and negation prefixes are not patterns', () => {
    assert.equal(compileIgnoreLine('# a comment', ''), null);
    assert.equal(compileIgnoreLine('   ', ''), null);
    assert.equal(compileIgnoreLine('!keep.log', '')?.negated, true);
    assert.equal(compileIgnoreLine('dist/', '')?.dirOnly, true);
  });

  test('a nested .gitignore is anchored to its own directory', () => {
    assert.equal(M('/local.txt', 'pkg/local.txt', 'pkg'), true);
    assert.equal(M('/local.txt', 'local.txt', 'pkg'), false);
  });

  test('everything under an ignored DIRECTORY is ignored, and git does not un-ignore it', () => {
    const dir = repo();
    write(dir, '.gitignore', 'vendor/\n!vendor/keep.txt\n');
    write(dir, 'a.txt', 'x\n');
    commitAll(dir);
    write(dir, 'vendor/lib.js', 'x\n');
    write(dir, 'vendor/keep.txt', 'x\n');
    clearGitStateCache();
    const gitDir = resolveGitDir(dir)!;
    // git's own documented behaviour: "It is not possible to re-include a file if a parent
    // directory of that file is excluded." Our matcher must agree, including on the negation.
    assert.equal(isIgnored('vendor/lib.js', dir, gitDir), true);
    assert.equal(isIgnored('vendor/keep.txt', dir, gitDir), true);
    assert.equal(gitSays(dir, 'vendor/keep.txt'), 'ignored');
  });

  test('.git/info/exclude is honoured', () => {
    const dir = repo();
    write(dir, 'a.txt', 'x\n');
    commitAll(dir);
    const gitDir = resolveGitDir(dir)!;
    fs.mkdirSync(path.join(gitDir, 'info'), { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'info', 'exclude'), 'secret-notes.md\n');
    write(dir, 'secret-notes.md', 'x\n');
    clearGitStateCache();
    assert.equal(gitFileState(path.join(dir, 'secret-notes.md'), dir), 'ignored');
    assert.equal(gitSays(dir, 'secret-notes.md'), 'ignored');
  });
});
