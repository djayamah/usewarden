import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { Store } from '../src/store.js';
import { handleEvent } from '../src/engine/pipeline.js';
import { loadPolicy } from '../src/policy/load.js';
import { clearGitStateCache } from '../src/engine/gitstate.js';
import { sandbox, gitInit, ev, run, type Sandbox } from './helpers.js';

/**
 * `scope.protect_uncommitted` THROUGH THE WHOLE PIPELINE, not just through Layer 1.
 *
 * `tests/policy-coverage.test.ts` measures the rule against both corpora. This file tests the part
 * a corpus cannot reach: the `agentAuthored` signal, which comes out of the event store and is the
 * difference between a guard that protects the human's work and a guard that refuses the agent's
 * own second write to its own file.
 *
 * The order it is computed in is load-bearing. `handleEvent` records the incoming event before it
 * evaluates policy, so asking the store afterwards would find the current write and let every
 * overwrite answer for itself. That would not fail loudly - it would silently never fire, which is
 * the failure mode SPEC-BUILD section 5 names as the worst one this product has.
 */
describe('git awareness end to end', () => {
  let sb: Sandbox;
  beforeEach(() => { sb = sandbox(); clearGitStateCache(); });
  afterEach(() => { sb.cleanup(); });

  const store = (): Store => new Store(path.join(sb.usewardenHome, 'usewarden.db'));
  const write = async (s: Store, rel: string): Promise<string> => {
    const res = await handleEvent(s, ev({
      tool: 'write', rawTool: 'Write', filePath: path.join(sb.repo, rel), cwd: sb.repo,
      sessionId: 'session-one',
    }), { live: false, loaded: loadPolicy(sb.repo), noJudge: true });
    return res.verdict.decision;
  };

  test('THE SETUP LANDS: an untracked file with contents really is sitting in the repo', () => {
    gitInit(sb.repo);
    fs.writeFileSync(path.join(sb.repo, 'notes.md'), 'the human wrote this and never committed it\n');
    const porcelain = run('git', ['-C', sb.repo, 'status', '--porcelain', '-uall']);
    assert.match(porcelain, /^\?\? notes\.md$/m, 'setup failed: notes.md is not untracked');
    assert.ok(fs.readFileSync(path.join(sb.repo, 'notes.md'), 'utf8').length > 0);
  });

  test('overwriting the human’s untracked file is BLOCKED and recorded', async () => {
    gitInit(sb.repo);
    fs.writeFileSync(path.join(sb.repo, 'notes.md'), 'the human wrote this\n');
    clearGitStateCache();
    const s = store();
    assert.equal(await write(s, 'notes.md'), 'deny');
    const rows = s.recentIncidents();
    assert.equal(rows.length, 1);
    assert.match(rows[0]!.rule, /protect_uncommitted \(untracked\)/);
    assert.match(rows[0]!.title, /work git cannot restore/);
    // The message has to be one the agent can act on without asking anyone.
    assert.match(rows[0]!.reason, /Put the current contents somewhere recoverable first/);
    s.close();
  });

  test('overwriting uncommitted CHANGES to a tracked file is BLOCKED', async () => {
    gitInit(sb.repo);
    fs.writeFileSync(path.join(sb.repo, 'README.md'), 'an hour of edits, uncommitted\n');
    clearGitStateCache();
    const s = store();
    assert.equal(await write(s, 'README.md'), 'deny');
    assert.match(s.recentIncidents()[0]!.rule, /protect_uncommitted \(modified\)/);
    s.close();
  });

  test('THE REGRESSION THAT WOULD MAKE THIS UNUSABLE: the agent may rewrite its OWN file', async () => {
    // The agent's first write creates the file; that write makes it untracked-with-contents. A
    // guard that only asked "is this file recoverable" would refuse the second write - so warden
    // would block normal work within one turn of being installed. This is that turn.
    gitInit(sb.repo);
    const s = store();
    assert.equal(await write(s, 'new-feature.ts'), 'allow', 'creating a new file must be allowed');
    fs.writeFileSync(path.join(sb.repo, 'new-feature.ts'), 'export const a = 1;\n');
    clearGitStateCache();
    assert.equal(await write(s, 'new-feature.ts'), 'allow',
      'the agent must be able to rewrite the file it just created');
    assert.equal(s.countIncidents(), 0, 'and none of that is an incident');
    s.close();
  });

  test('...but a DIFFERENT session does not inherit that permission', async () => {
    gitInit(sb.repo);
    const s = store();
    assert.equal(await write(s, 'new-feature.ts'), 'allow');
    fs.writeFileSync(path.join(sb.repo, 'new-feature.ts'), 'export const a = 1;\n');
    clearGitStateCache();
    const res = await handleEvent(s, ev({
      tool: 'write', rawTool: 'Write', filePath: path.join(sb.repo, 'new-feature.ts'), cwd: sb.repo,
      sessionId: 'a-completely-different-session',
    }), { live: false, loaded: loadPolicy(sb.repo), noJudge: true });
    assert.equal(res.verdict.decision, 'deny',
      'uncommitted work left behind by an earlier session is still work nobody can get back');
    s.close();
  });

  test('an EDIT of an untracked file is allowed — it does not replace the file', async () => {
    gitInit(sb.repo);
    fs.writeFileSync(path.join(sb.repo, 'notes.md'), 'the human wrote this\n');
    clearGitStateCache();
    const s = store();
    const res = await handleEvent(s, ev({
      tool: 'edit', rawTool: 'Edit', filePath: path.join(sb.repo, 'notes.md'), cwd: sb.repo,
    }), { live: false, loaded: loadPolicy(sb.repo), noJudge: true });
    assert.equal(res.verdict.decision, 'allow');
    s.close();
  });

  test('a project that is not a git repository at all is never blocked by this rule', async () => {
    // No repo means no answer, and no answer must mean no verdict. A guard that fires when it
    // cannot see is a guard that fires on everyone who does not use git.
    fs.writeFileSync(path.join(sb.repo, 'notes.md'), 'x\n');
    clearGitStateCache();
    const s = store();
    assert.equal(await write(s, 'notes.md'), 'allow');
    s.close();
  });

  test('the guard does not outrank the forbidden list or scope', async () => {
    // Ordering matters for the message the agent gets: a .env is a credential problem, not a
    // "commit this first" problem, and telling it to commit its .env would be actively wrong.
    gitInit(sb.repo);
    fs.writeFileSync(path.join(sb.repo, '.env'), 'TOKEN=x\n');
    clearGitStateCache();
    const s = store();
    assert.equal(await write(s, '.env'), 'deny');
    assert.match(s.recentIncidents()[0]!.rule, /forbidden_paths/);
    s.close();
  });
});
