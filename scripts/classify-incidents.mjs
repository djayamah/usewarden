/**
 * For every REAL incident in the record, ask one question: would the dangerous thing actually
 * have happened?
 *
 * WHY THIS EXISTS. `ops/DOGFOOD.md` reported "12 blocked `npm publish` calls — your own standing
 * rule, enforced twelve times". Reading the stored commands showed that **not one of them was a
 * publish**. Every one was an agent writing a document, a commit message, a decision log or a
 * test fixture whose TEXT contained the release command. The headline was not slightly generous;
 * it was backwards. This script exists so that number is computed from the record instead of
 * being read off a rule-id histogram, and so it can be recomputed by anyone.
 *
 * THE TEST, and its limits, stated rather than implied.
 *
 * A stored incident keeps the whole command line the agent declared. This strips the parts a
 * shell would NOT execute as a command in that position — heredoc bodies, and single- and
 * double-quoted string literals — and re-runs the rule's own pattern over what is left:
 *
 *   FIRED-ON-COMMAND   the pattern still matches. The agent really was invoking the thing.
 *   FIRED-ON-TEXT      the pattern matches only inside a body or a quoted literal. The command
 *                      was writing or printing text ABOUT the dangerous thing.
 *   FILE-TOOL          no command at all - a Read/Write/Edit event carrying a path. There is no
 *                      text/command ambiguity to resolve, so these are real by construction.
 *
 * This is deliberately CONSERVATIVE about calling something a false positive. A `python3 - <<PY`
 * body really is executed by python, so stripping it could in principle hide a genuine action —
 * which is why the report prints every FIRED-ON-TEXT command, so the classification can be
 * checked by eye rather than believed. It answers "did the shell command line itself invoke
 * this", which is the question the deny rule is written as if it were asking.
 *
 * Usage: node scripts/classify-incidents.mjs [--db PATH] [--full]
 */
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { defaultCommandDeny } from '../dist/src/policy/schema.js';
import { stripDataHeredocs } from '../dist/src/engine/layer1.js';

const argv = process.argv.slice(2);
const dbFile = argv.includes('--db') ? argv[argv.indexOf('--db') + 1]
  : path.join(os.homedir(), '.usewarden', 'usewarden.db');
const FULL = argv.includes('--full');

/** Remove heredoc bodies — every heredoc, not only the ones usewarden treats as data. */
function stripHeredocs(cmd) {
  let out = cmd;
  for (;;) {
    const m = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(out);
    if (!m) break;
    const delim = m[2];
    const after = out.slice(m.index + m[0].length);
    const end = new RegExp(`^[ \\t]*${delim}[ \\t]*$`, 'm').exec(after);
    if (!end) { out = out.slice(0, m.index) + ' <<STRIPPED ' + after.replace(/[\s\S]*/, ''); break; }
    out = out.slice(0, m.index) + ' <<STRIPPED ' + after.slice(end.index + end[0].length);
  }
  return out;
}

/** Does every heredoc opened in this command have its closing delimiter present? */
function terminatedHeredoc(cmd) {
  const lines = cmd.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(lines[i] ?? '');
    if (!m) continue;
    if (!lines.slice(i + 1).some((l) => l.trim() === m[2])) return false;
  }
  return true;
}

/** Remove quoted string literals, which a shell passes as one argument rather than running. */
function stripQuoted(cmd) {
  return cmd
    .replace(/'(?:[^'])*'/g, " 'STR' ")
    .replace(/"(?:[^"\\]|\\.)*"/g, ' "STR" ');
}

const db = new DatabaseSync(dbFile);
const rows = db.prepare(
  "SELECT id, ts, rule, tool, attempted, severity FROM incidents WHERE origin = 'live' ORDER BY ts ASC",
).all();

const deny = defaultCommandDeny();
const patternFor = (rule) => {
  const m = /\(([^)]+)\)\s*$/.exec(rule);
  const id = m ? m[1] : null;
  const r = deny.find((x) => x.id === id);
  return r ? new RegExp(r.pattern, 'i') : null;
};

const buckets = { 'FIRED-ON-COMMAND': [], 'FIRED-ON-TEXT': [], 'FILE-TOOL': [], 'NO-PATTERN': [] };

for (const r of rows) {
  const cmd = String(r.attempted ?? '');
  const isCmd = cmd.trimStart().startsWith('$');
  const pat = patternFor(String(r.rule));
  if (!isCmd) { buckets['FILE-TOOL'].push({ ...r, why: 'a file-tool event, no command text' }); continue; }
  if (!pat) { buckets['NO-PATTERN'].push({ ...r, why: 'not a commands.deny rule' }); continue; }
  // THE RECORD STORES A DISPLAY RENDERING, NOT THE ORIGINAL COMMAND.
  //
  // `oneLine()` (src/util.ts) collapses newlines to ' \u00b6 ' so a heredoc cannot tear an
  // incident card apart. That means a stored command has NO line boundaries, and every parser
  // downstream of it - including stripDataHeredocs, which must find a delimiter on a line of its
  // own - sees one enormous line. Replaying without undoing this measures a mangled command and
  // reports every heredoc as unterminated. Found by asking why a fix that demonstrably works in
  // tests changed nothing on the replay.
  //
  // The inverse is APPROXIMATE and says so: oneLine also collapses runs of newlines and squeezes
  // repeated spaces, so indentation is gone for good. Line boundaries are what heredoc parsing
  // needs, and those come back exactly.
  const raw = cmd.replace(/^\s*\$\s*/, '').split(' \u00b6 ').join('\n');
  const bare = stripQuoted(stripHeredocs(raw));
  // WOULD IT STILL FIRE TODAY? The record spans a period in which the engine changed: D-139 added
  // heredoc-body stripping on 2026-08-24, so an incident from 2026-08-20 was judged by a version
  // that did not have it. Counting historical firings as a verdict on the CURRENT product would
  // charge it for a defect it has already fixed. So each stored command is replayed through
  // today's stripDataHeredocs and the rule re-tested.
  // AND THE RECORD TRUNCATES. `attempted` is capped for storage, so a long command arrives here
  // with its tail - including a heredoc's closing delimiter - removed. A parser that needs the
  // terminator then reports "unterminated, scan it all", and the replay blames the engine for
  // something the STORAGE did. Truncated commands are reported as UNREPLAYABLE rather than as
  // still-firing: CLAUDE.md §4.4 - a thing that could not be checked is not a pass, and it is
  // not a failure of the thing being checked either.
  const truncated = /[…]$/.test(raw) || (raw.includes('<<') && !terminatedHeredoc(raw));
  const today = truncated ? 'unreplayable' : (pat.test(stripDataHeredocs(raw)) ? 'fires' : 'fixed');
  buckets[pat.test(bare) ? 'FIRED-ON-COMMAND' : 'FIRED-ON-TEXT'].push({ ...r, bare, today });
}

/**
 * Redact by construction (CLAUDE.md §2), because this output is committed to `verification/` and
 * `verification/` is published. The stored commands are REAL commands from a real machine, so they
 * carry its home directory, its Bonjour hostname and — inside one `git commit` invocation — an
 * email address. The publication sanitiser would rewrite most of that later; relying on it makes
 * this a second chance rather than a first one, and the identity never needs to be written here.
 *
 * Order matters: e-mail before hostname, because an address contains the host.
 */
const HOME = os.homedir();

/**
 * The operator-identity literals, read from the SAME untracked file the scanner uses.
 *
 * `scripts/scan-identity.txt` is untracked by design - writing the literals into a tracked file
 * would put them exactly where they must not be. This script reads it rather than carrying a list
 * of its own, for the reason `internal-only-paths.txt` gives about its own three consumers: two
 * copies of a list drift, and the drift is invisible until it leaks. A public checkout has no such
 * file and needs none, because the transcript is regenerated rather than carried.
 *
 * Sorted longest-first so a literal that contains another is replaced whole.
 */
const IDENTITY = (() => {
  let lits = [];
  try {
    const raw = fs.readFileSync(new URL('./scan-identity.txt', import.meta.url), 'utf8');
    lits = raw.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
  } catch { /* absent in a public checkout, and needed only where the machine is */ }
  // The same four DERIVED literals scan-text-for-publication.sh adds to the file's contents.
  // Kept in step with it deliberately: a redactor that knows about fewer identities than the
  // scanner is a redactor that produces output the scanner then rejects, which is exactly what
  // happened on the first attempt (4 literals here against the scanner's 7).
  for (const extra of [process.env['USER'], os.hostname(),
    process.env['SCAN_LOCALHOST'], path.basename(os.homedir())]) {
    if (extra && extra.length > 2 && !lits.includes(extra)) lits.push(extra);
  }
  return lits.sort((a, b) => b.length - a.length);
})();

function scrub(text) {
  let out = String(text)
    .split(HOME).join('~')
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '<email>')
    .replace(/\b[\w-]+\.local\b/g, '<host>')
    .replace(/\/(?:Users|home)\/[^/\s"')]+/g, '~');
  for (const lit of IDENTITY) {
    if (lit.length < 3) continue;
    out = out.split(lit).join('<redacted>');
    // The literals are names; the commands contain them in whatever case they were typed.
    const re = new RegExp(lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out = out.replace(re, '<redacted>');
  }
  return out;
}

const one = (s, n) => scrub(String(s)).replace(/\s+/g, ' ').trim().slice(0, n);

console.log('=== WOULD THE DANGEROUS THING ACTUALLY HAVE HAPPENED? ===');
console.log(`record   ${dbFile.split(os.homedir()).join('~')}`);
console.log(`date     ${new Date().toISOString()}`);
console.log(`incidents from REAL agent sessions: ${rows.length}\n`);

for (const [k, v] of Object.entries(buckets)) {
  console.log(`${k.padEnd(18)} ${String(v.length).padStart(3)}`);
}

const n_ = (k) => buckets['FIRED-ON-TEXT'].filter((r) => r.today === k).length;
console.log('');
console.log(`of the ${buckets['FIRED-ON-TEXT'].length} that fired on TEXT, replayed against today's engine:`);
console.log(`  ${String(n_('fixed')).padStart(3)}  no longer fire`);
console.log(`  ${String(n_('fires')).padStart(3)}  WOULD STILL FIRE`);
console.log(`  ${String(n_('unreplayable')).padStart(3)}  UNREPLAYABLE - the stored command is truncated, so the`);
console.log('       heredoc terminator is missing and no parser can judge it.');
console.log('       Counted against the total, never as a pass (CLAUDE.md §4.4).');

console.log('\n--- FIRED-ON-TEXT: the command was writing or printing text, not running it ---');
console.log('(every one printed, so the classification can be checked rather than believed)');
console.log('(FIXED = the current engine no longer matches it; UNREPLAYABLE = stored command truncated)\n');
for (const r of buckets['FIRED-ON-TEXT']) {
  const tag = { fires: 'STILL-FIRES', fixed: 'FIXED', unreplayable: 'UNREPLAYABLE' }[r.today];
  console.log(`  #${String(r.id).padStart(3)}  [${tag.padEnd(12)}]  ${r.rule}`);
  console.log(`        ${one(r.attempted, 150)}`);
  if (FULL) console.log(`        after stripping: ${one(r.bare, 150)}`);
}

console.log('\n--- FIRED-ON-COMMAND: the shell really was about to do it ---\n');
for (const r of buckets['FIRED-ON-COMMAND']) {
  console.log(`  #${String(r.id).padStart(3)}  ${r.rule}`);
  console.log(`        ${one(r.attempted, 150)}`);
}

console.log('\n--- FILE-TOOL: a Read/Write/Edit carrying a path; no ambiguity to resolve ---\n');
for (const r of buckets['FILE-TOOL']) {
  console.log(`  #${String(r.id).padStart(3)}  ${r.rule}  ${one(r.attempted, 110)}`);
}

console.log('\n=== BY RULE ===');
const byRule = new Map();
for (const [k, v] of Object.entries(buckets)) {
  for (const r of v) {
    const key = String(r.rule);
    if (!byRule.has(key)) byRule.set(key, { 'FIRED-ON-COMMAND': 0, 'FIRED-ON-TEXT': 0, 'FILE-TOOL': 0, 'NO-PATTERN': 0 });
    byRule.get(key)[k]++;
  }
}
console.log('rule'.padEnd(42), 'command', 'text', 'file-tool');
for (const [k, v] of [...byRule.entries()].sort((a, b) =>
  (b[1]['FIRED-ON-COMMAND'] + b[1]['FIRED-ON-TEXT'] + b[1]['FILE-TOOL']) -
  (a[1]['FIRED-ON-COMMAND'] + a[1]['FIRED-ON-TEXT'] + a[1]['FILE-TOOL']))) {
  console.log(k.padEnd(42),
    String(v['FIRED-ON-COMMAND']).padStart(7),
    String(v['FIRED-ON-TEXT']).padStart(4),
    String(v['FILE-TOOL'] + v['NO-PATTERN']).padStart(9));
}
