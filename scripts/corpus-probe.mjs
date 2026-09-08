/**
 * Read facts out of a corpus database without going through a shell.
 *
 * This file exists because the first version of verify-corpus-backup.sh inlined its SQL in
 * `node -e '...'`, and the shell ate the inner quotes: `origin='live'` arrived as `origin=live`.
 * `live` IS a column on the incidents table, so SQLite did not error — it compared a text column
 * to an integer column, matched nothing, and reported zero real incidents in a corpus holding
 * dozens. A silently wrong answer from a proof script is the exact failure the proof is meant to
 * catch, and it was caught only because the script asserts its preconditions before testing
 * anything (CLAUDE.md §4.2). SQL lives in a file now.
 *
 * Usage: node scripts/corpus-probe.mjs <db> counts|witness|session <arg?>
 */
import { DatabaseSync } from 'node:sqlite';

const [, , file, mode, arg] = process.argv;
if (!file || !mode) {
  process.stderr.write('usage: corpus-probe.mjs <db> counts|witness|session [arg]\n');
  process.exit(2);
}

const db = new DatabaseSync(file);
const one = (sql, ...p) => db.prepare(sql).get(...p);

switch (mode) {
  case 'counts': {
    const c = (sql, ...p) => Number(one(sql, ...p).c);
    process.stdout.write([
      c('SELECT COUNT(*) AS c FROM sessions'),
      c('SELECT COUNT(*) AS c FROM events'),
      c('SELECT COUNT(*) AS c FROM incidents'),
      c("SELECT COUNT(*) AS c FROM incidents WHERE origin = 'live'"),
    ].join(' ') + '\n');
    break;
  }
  case 'witness': {
    // The oldest real blocked publish. Chosen deliberately: it is the incident the founder's own
    // standing rule is about, it is unambiguous in a receipt, and it cannot be produced by a
    // fixture or a demo because those never carry origin='live'.
    // `rule` stores the POLICY PATH, not the rule id: `commands.deny[9] (npm-publish)`. An
    // equality match on 'npm-publish' finds nothing and, under `set -e`, kills the proof script
    // rather than failing an assertion — which is how this was found.
    const r = one(
      "SELECT id, rule, session_id FROM incidents WHERE origin = 'live' AND rule LIKE '%(npm-publish)%' ORDER BY ts ASC LIMIT 1",
    );
    if (!r) process.exit(3);
    process.stdout.write(`${r.id} ${r.rule} ${r.session_id}\n`);
    break;
  }
  case 'session': {
    const r = one('SELECT session_id AS c FROM incidents WHERE id = ?', Number(arg));
    if (!r) process.exit(3);
    process.stdout.write(String(r.c) + '\n');
    break;
  }
  default:
    process.stderr.write(`unknown mode ${mode}\n`);
    process.exit(2);
}
