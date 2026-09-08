/**
 * Answer one question about a database file: does SQLite accept it?
 *
 * Used as the negative control in verify-corpus-backup.sh. Prints ACCEPTED-ok or REJECTED-<why>
 * and never throws, so the caller can assert on the word rather than on an exit code that a
 * corrupt file might produce for the wrong reason.
 */
import { DatabaseSync } from 'node:sqlite';
const file = process.argv[2];
try {
  const db = new DatabaseSync(file);
  const v = Object.values(db.prepare('PRAGMA integrity_check').get())[0];
  process.stdout.write((v === 'ok' ? 'ACCEPTED-ok' : 'REJECTED-' + String(v).split('\n')[0]) + '\n');
} catch (e) {
  process.stdout.write('REJECTED-' + e.message.split('\n')[0] + '\n');
}
