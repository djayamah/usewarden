#!/usr/bin/env node
/**
 * REPO HEALTH — EVERY REPOSITORY THIS PROJECT PUSHES TO, NOT THE ONE BEING WORKED ON.
 *
 * WHY THIS EXISTS
 *
 * On 2026-09-08 a run fixed a Dependabot defect on the public repository, swept the public
 * repository, and reported "all CI green". It was true, and it was about the wrong surface: at
 * that exact moment `djayamah/warden` — the PRIVATE mirror, where every one of those commits
 * actually landed first — had four failed workflow runs, two of them caused by that very run, and
 * a `pages` workflow that had never once succeeded in its life.
 *
 * That is the same defect this project has now hit repeatedly in different clothes: a control
 * aimed at one surface while the failure is on another. `allowed_paths` pointed at a directory
 * nobody used. `dependabot.yml` named a label that did not exist. A drift guardian was registered
 * and never invoked. Each time the check was real, the answer it gave was true, and it was
 * answering about somewhere the problem was not.
 *
 * THE RULE THAT MAKES THIS DIFFERENT FROM A NICER `gh run list`
 *
 *   **Reporting green on a subset is a FAILURE, not a partial pass.**
 *
 * The set of repositories is DERIVED from the git remotes, not typed in here, so adding a remote
 * widens the check automatically and nobody has to remember. If any expected repository cannot be
 * reached, the run is UNVERIFIED — never "the ones I could see are fine". `--expect N` asserts the
 * count as well, so a remote silently disappearing is caught rather than quietly narrowing the
 * sweep.
 *
 * WHAT IT LOOKS AT, per repository
 *   - failed workflow runs on the default branch
 *   - workflows that exist and have NEVER succeeded (a run that is always red is a run nobody
 *     reads, and it hides the next real failure inside it)
 *   - open pull requests, and how long they have been open
 *   - open issues
 *   - branches merged into the default branch and never deleted
 *
 * EXIT CODES
 *   0  every repository reachable, and healthy
 *   1  something is failing, or fewer repositories were checked than exist
 *   3  UNVERIFIED — GitHub unreachable or `gh` unauthenticated. Not a pass (CLAUDE.md §4.4).
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STALE_PR_DAYS = 14;

class Unverified extends Error {}

function gh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', cwd: REPO });
  if (r.error && r.error.code === 'ENOENT') throw new Unverified('the `gh` CLI is not installed');
  return r;
}

function api(endpoint, jq) {
  const args = ['api', endpoint, '--paginate'];
  if (jq) args.push('--jq', jq);
  const r = gh(args);
  if (r.status !== 0) {
    const err = (r.stderr || '').trim().split('\n')[0];
    if (/HTTP 401|not logged|gh auth login/i.test(err)) throw new Unverified(`not authenticated to GitHub: ${err}`);
    if (/dial tcp|no such host|network|timeout|connection refused|Could not resolve/i.test(err)) {
      throw new Unverified(`GitHub was unreachable: ${err}`);
    }
    return { ok: false, err };
  }
  return { ok: true, out: r.stdout };
}

function json(endpoint, jq) {
  const r = api(endpoint, jq);
  if (!r.ok) return { ok: false, err: r.err };
  const text = r.out.trim();
  if (text === '') return { ok: true, value: [] };
  // `gh api --jq '.x[] | {…}'` emits ONE JSON OBJECT PER LINE, not an array, and `--paginate`
  // concatenates a page's worth of those per page. Parsing the whole blob fails, which the first
  // version reported as "unreachable" for both repositories - a check that reports a parsing bug
  // in itself as a fact about the world. Line-by-line first, whole-document second.
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const objs = [];
  let allParsed = true;
  for (const l of lines) {
    try { objs.push(JSON.parse(l)); } catch { allParsed = false; break; }
  }
  if (allParsed) return { ok: true, value: objs };
  try { return { ok: true, value: JSON.parse(text) }; } catch { /* fall through */ }
  try { return { ok: true, value: JSON.parse(`[${text.replace(/\]\s*\[/g, ',')}]`.replace(/^\[\[/, '[').replace(/\]\]$/, ']')) }; }
  catch { return { ok: false, err: 'unparseable JSON from the API' }; }
}

/**
 * THE REPOSITORY SET, FROM TWO INDEPENDENT SOURCES THAT MUST AGREE.
 *
 * `scripts/repos.txt` says which repositories this project pushes to. The git remotes say which
 * ones this checkout can actually reach. Either alone silently narrows:
 *
 *   - remotes alone: a remote removed, renamed, or absent on a fresh clone shrinks the sweep and
 *     the sweep then reports green about a smaller world than the project has. That is D-273.
 *   - the file alone: a remote added and never recorded is a repository nobody decided to sweep.
 *
 * So both are read and any disagreement is a hard failure, in either direction. Same shape as
 * `scripts/internal-only-paths.txt`: one list, several readers, and no reader with its own copy.
 */
function declaredRepos() {
  const f = path.join(REPO, 'scripts', 'repos.txt');
  if (!fs.existsSync(f)) throw new Unverified('scripts/repos.txt is missing - the expected repository set is unknown');
  const list = fs.readFileSync(f, 'utf8').split('\n')
    .map((l) => l.replace(/#.*/, '').trim()).filter((l) => l !== '');
  if (list.length === 0) throw new Unverified('scripts/repos.txt is empty - refusing to sweep an unstated set');
  return list;
}

function remoteRepos() {
  const r = spawnSync('git', ['remote', '-v'], { encoding: 'utf8', cwd: REPO });
  if (r.status !== 0) throw new Unverified('cannot read git remotes');
  const found = new Map();
  for (const line of (r.stdout || '').split('\n')) {
    const m = /^(\S+)\s+\S*github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?\s/.exec(line);
    if (m) found.set(m[2], m[1]);
  }
  return found;
}

const ago = (iso) => Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);

function checkRepo(slug) {
  const problems = [];
  const notes = [];

  const meta = json(`repos/${slug}`, '{d:.default_branch,p:.private,a:.archived}');
  if (!meta.ok) return { unreachable: meta.err, problems, notes };
  const m = Array.isArray(meta.value) ? meta.value[0] : meta.value;
  if (!m || !m.d) return { unreachable: 'the API returned no default branch for this repository', problems, notes };
  const branch = m.d;
  notes.push(`${m.p ? 'private' : 'public'}, default branch ${branch}`);

  // --- workflow runs ---------------------------------------------------------------------
  const runs = json(`repos/${slug}/actions/runs?per_page=100`,
    '.workflow_runs[] | {n:.name,c:.conclusion,s:.status,b:.head_branch,sha:.head_sha,t:.created_at,id:.id}');
  if (!runs.ok) return { unreachable: `cannot read workflow runs: ${runs.err}`, problems, notes };
  const all = Array.isArray(runs.value) ? runs.value : [runs.value];

  // WHAT IS RED *NOW*, NOT EVERY FAILURE SINCE AUGUST.
  //
  // The first version listed every failed run in the API's window and produced 38 findings, most
  // of them on commits superseded weeks ago. A report nobody can act on is a report nobody reads -
  // which is the failure mode this whole script exists to catch, so it must not be the failure
  // mode of the script itself. Current health is: the MOST RECENT run of each workflow on the
  // default branch, plus failures on branches that still exist.
  const newestFirst = [...all].sort((a, b) => Date.parse(b.t) - Date.parse(a.t));

  const latestOnDefault = new Map();
  for (const r of newestFirst) {
    if (r.b !== branch || r.c === null || r.c === 'skipped' || r.c === 'cancelled') continue;
    if (!latestOnDefault.has(r.n)) latestOnDefault.set(r.n, r);
  }
  for (const [name, r] of latestOnDefault) {
    if (r.c === 'failure') {
      problems.push(`${slug}: ${name} is RED on ${branch} — newest run ${r.id} at ${r.sha.slice(0, 8)} (${r.t})`);
    }
  }

  // Failures on side branches matter only while the branch is still there; one on a branch that
  // was merged and deleted is history.
  const liveBranches = json(`repos/${slug}/branches?per_page=100`, '.[] | .name');
  const liveNames = new Set(liveBranches.ok
    ? (Array.isArray(liveBranches.value) ? liveBranches.value : [liveBranches.value]).filter(Boolean)
    : []);
  const latestOnSide = new Map();
  for (const r of newestFirst) {
    if (r.b === branch || !liveNames.has(r.b) || r.c === null || r.c === 'skipped' || r.c === 'cancelled') continue;
    const key = `${r.b}::${r.n}`;
    if (!latestOnSide.has(key)) latestOnSide.set(key, r);
  }
  for (const [, r] of latestOnSide) {
    if (r.c === 'failure') {
      problems.push(`${slug}: ${r.n} is RED on live branch ${r.b} — newest run ${r.id} at ${r.sha.slice(0, 8)} (${r.t})`);
    }
  }

  const historic = all.filter((r) => r.c === 'failure').length;
  if (historic > 0) notes.push(`${slug}: ${historic} failed run(s) in the API window, historical unless named above`);

  // A workflow that has NEVER once succeeded. This is the one that hid for a fortnight: `pages` on
  // the private mirror could not succeed at all, so its red was background noise and the SECOND,
  // real failure inside it was invisible. Not a "current run" question - a workflow question.
  const byWorkflow = new Map();
  for (const r of all) {
    if (!byWorkflow.has(r.n)) byWorkflow.set(r.n, []);
    byWorkflow.get(r.n).push(r);
  }
  for (const [name, rs] of byWorkflow) {
    const finished = rs.filter((r) => r.c !== null && r.c !== 'skipped' && r.c !== 'cancelled');
    if (finished.length === 0) continue;
    if (!finished.some((r) => r.c === 'success')) {
      problems.push(`${slug}: workflow "${name}" has NEVER succeeded — ${finished.length} finished run(s), none green`);
    }
  }

  // --- pull requests ---------------------------------------------------------------------
  const prs = json(`repos/${slug}/pulls?state=open&per_page=100`, '.[] | {n:.number,t:.title,c:.created_at,u:.user.login}');
  if (prs.ok) {
    const list = Array.isArray(prs.value) ? prs.value : (prs.value ? [prs.value] : []);
    for (const p of list) {
      const days = ago(p.c);
      const line = `${slug}: PR #${p.n} open ${days}d — ${p.t} (${p.u})`;
      if (days >= STALE_PR_DAYS) problems.push(`${line}  [stale, over ${STALE_PR_DAYS}d]`);
      else notes.push(line);
    }
  } else notes.push(`${slug}: could not read pull requests (${prs.err})`);

  // --- issues ----------------------------------------------------------------------------
  const issues = json(`repos/${slug}/issues?state=open&per_page=100`, '.[] | select(.pull_request == null) | {n:.number,t:.title,c:.created_at}');
  if (issues.ok) {
    const list = Array.isArray(issues.value) ? issues.value : (issues.value ? [issues.value] : []);
    for (const i of list) notes.push(`${slug}: issue #${i.n} open ${ago(i.c)}d — ${i.t}`);
  }

  // --- branches besides the default one -----------------------------------------------------
  const others = [...liveNames].filter((n) => n !== branch);
  if (others.length > 0) notes.push(`${slug}: ${others.length} branch(es) besides ${branch}: ${others.join(', ')}`);

  return { unreachable: null, problems, notes };
}

function main() {
  const expectArg = process.argv.find((a) => a.startsWith('--expect='));
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));

  console.log('=== repo health ===');
  console.log(`captured: ${new Date().toISOString()}`);

  const declared = declaredRepos();
  const remotes = remoteRepos();

  console.log(`declared in scripts/repos.txt: ${declared.length}`);
  for (const slug of declared) console.log(`  ${slug}\t${remotes.get(slug) ? `remote "${remotes.get(slug)}"` : 'NO REMOTE CONFIGURED'}`);

  // THE FILE IS THE SWEEP SET. THE REMOTES ARE A LOCAL CONVENIENCE, AND CANNOT NARROW IT.
  //
  // The first version treated a declared repository with no configured remote as fatal, and CI
  // proved that wrong within minutes: a GitHub runner clones ONE repository, so it has exactly one
  // remote by construction and the check failed on every runner. Worse, it was the same mistake
  // this script is about - letting an environment-specific detail decide what "all of them" means.
  //
  // So the file decides the set, always, and the remotes are checked only in the direction that is
  // meaningful everywhere:
  //
  //   a remote nobody declared        -> FAILURE. A push target outside the sweep.
  //   a declared repo with no remote  -> a note. Normal on a runner and on a fresh clone, and it
  //                                      does not shrink the sweep, because the file decides.
  const undeclared = [...remotes.keys()].filter((slug) => !declared.includes(slug));
  if (undeclared.length > 0) {
    console.error('\nFAIL  a git remote points at a repository scripts/repos.txt does not name:');
    for (const slug of undeclared) console.error(`        ${slug}  (remote "${remotes.get(slug)}")`);
    console.error('      A push target nobody sweeps is exactly what this check exists to prevent.');
    return 1;
  }
  const noRemote = declared.filter((slug) => !remotes.has(slug));
  if (noRemote.length > 0) {
    console.log(`  note: ${noRemote.length} declared repositor(y/ies) have no remote in this checkout`);
    console.log('        (normal on a CI runner or a fresh clone; the sweep still covers them)');
  }

  let repos = declared.map((slug) => ({ slug, remote: remotes.get(slug) ?? '(no local remote)' }));

  // `--only` EXISTS FOR THE SABOTAGE TEST AND CAN NEVER REPORT GREEN.
  //
  // The first version let a narrowed sweep print "ALL 1 REPOSITORY HEALTHY", which is the precise
  // sentence this script was written to stop anyone from writing. Narrowing is now loud and
  // non-zero by construction; `--allow-narrow` exists only so the sabotage test can show the
  // narrowed output without the run being called a pass.
  const narrowed = onlyArg ? onlyArg.slice('--only='.length).split(',') : null;
  if (narrowed) repos = repos.filter((r) => narrowed.includes(r.slug));

  if (expectArg) {
    const want = Number(expectArg.slice('--expect='.length));
    if (repos.length !== want) {
      console.error(`\nFAIL  expected ${want} repositor(y/ies), about to check ${repos.length}.`);
      return 1;
    }
  }

  // `--dry-run` answers "does this sweep know its own scope?" and makes NO network calls. It is
  // what the test suite uses, because the scope question is the one that has actually gone wrong
  // and it must be answerable on a runner that can reach only one of the repositories.
  if (process.argv.includes('--dry-run')) {
    console.log(`\nwould sweep ${repos.length} repositor(y/ies): ${repos.map((r) => r.slug).join(', ')}`);
    if (narrowed) {
      console.error(`=== NARROWED SWEEP: ${repos.length} of ${declared.length} declared repositor(y/ies) ===`);
      console.error('    A subset is not a statement about this project.');
      return process.argv.includes('--allow-narrow') ? 0 : 1;
    }
    console.log('dry run: scope resolved, nothing contacted.');
    return 0;
  }

  const allProblems = [];
  const allNotes = [];
  const unreachable = [];

  for (const { slug } of repos) {
    console.log(`\n--- ${slug} ---`);
    const r = checkRepo(slug);
    if (r.unreachable) {
      unreachable.push(`${slug}: ${r.unreachable}`);
      console.log(`  UNREACHABLE: ${r.unreachable}`);
      continue;
    }
    for (const n of r.notes) console.log(`  ${n}`);
    for (const p of r.problems) console.log(`  PROBLEM: ${p.replace(`${slug}: `, '')}`);
    if (r.problems.length === 0) console.log('  no failing runs, no stale pull requests');
    allProblems.push(...r.problems);
    allNotes.push(...r.notes);
  }

  console.log('');
  // UNREACHABLE IS COUNTED AGAINST THE TOTAL, never folded into the green. Checking 1 of 2 and
  // saying "healthy" is precisely what went wrong.
  if (unreachable.length > 0) {
    console.error(`FAIL  ${unreachable.length} of ${repos.length} repositor(y/ies) could not be checked:`);
    for (const u of unreachable) console.error(`        ${u}`);
    console.error('      This is NOT a partial pass. A sweep that skipped a repository has not swept.');
    if (allProblems.length > 0) for (const p of allProblems) console.error(`FAIL  ${p}`);
    return 1;
  }

  if (allProblems.length > 0) {
    console.error(`=== ${allProblems.length} PROBLEM(S) ACROSS ${repos.length} REPOSITOR(Y/IES) ===\n`);
    for (const p of allProblems) console.error(`FAIL  ${p}`);
    return 1;
  }

  if (narrowed) {
    console.error(`=== NARROWED SWEEP: ${repos.length} of ${declared.length} declared repositor(y/ies) ===`);
    console.error('    The ones checked are healthy. That is NOT a statement about this project,');
    console.error('    which is the whole reason this script exists. Re-run without --only.');
    return process.argv.includes('--allow-narrow') ? 0 : 1;
  }
  console.log(`=== ALL ${repos.length} REPOSITOR(Y/IES) HEALTHY ===`);
  console.log('    no failed runs, no workflow that has never succeeded, no stale pull request.');
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  if (e instanceof Unverified) {
    console.log(`UNVERIFIED  ${e.message}`);
    console.log('            No repository was checked. This is not a pass (CLAUDE.md §4.4).');
    process.exit(3);
  }
  throw e;
}
