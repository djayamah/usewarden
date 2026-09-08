import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Corpus } from '../../triage/src/corpus.js';
import { buildAnswer } from '../../triage/src/answer.js';
import { AUTO_POST, buildDraft, isEligible, type XPost } from './policy.js';

/**
 * Draft mode. Reads candidate posts from stdin as JSON and writes drafts to stdout.
 *
 * It does not connect to X. There is no API client in this repository and no credential is read.
 * Connecting is a founder action documented in ops/X-BOT-SETUP.md, and `AUTO_POST` is false.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<number> {
  if (AUTO_POST) {
    process.stderr.write('x-bot: AUTO_POST is true but no API client exists. Refusing.\n');
    return 1;
  }
  const raw = (await readStdin()).trim();
  if (!raw) {
    process.stdout.write('x-bot: pipe a JSON array of posts on stdin. Nothing was sent; this only drafts.\n');
    return 0;
  }
  const posts = JSON.parse(raw) as XPost[];
  const corpus = new Corpus(REPO);
  const ctx = { selfId: 'self', ourPostIds: new Set<string>(), alreadyRepliedTo: new Set<string>() };

  for (const p of posts) {
    const e = isEligible(p, ctx);
    if (!e.eligible) { process.stdout.write(`SKIP ${p.id}: ${e.reason}\n`); continue; }
    const a = buildAnswer(corpus, p.text);
    const firstLine = a.body.split('\n').filter((l) => l.startsWith('> ')).map((l) => l.slice(2))
      .join(' ').replace(/\s+/g, ' ').trim();
    const draft = buildDraft(p, { answered: a.answered, citations: a.citations, firstLine });
    if (!draft) { process.stdout.write(`DECLINE ${p.id}: nothing in the repo answers this\n`); continue; }
    process.stdout.write(`DRAFT for ${p.id} (cites ${draft.citations.join(', ')}):\n${draft.text}\n\n`);
  }
  process.stdout.write('x-bot: drafts only. Nothing was posted.\n');
  return 0;
}

main().then((c) => { process.exitCode = c; }).catch((e: Error) => {
  process.stderr.write(`x-bot: ${e.message}\n`); process.exitCode = 1;
});
