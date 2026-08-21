import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Corpus } from './corpus.js';
import { classifyIntent } from './intent.js';
import { type Issue } from './triage.js';
import { runAdversarialEval, ADVERSARIAL_SET } from './adversarial-eval.js';

/** Prints the adversarial-eval score. Run before and after a change; both numbers get reported. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const corpus = new Corpus(REPO_ROOT);
const results = runAdversarialEval(corpus, (i: Issue) => classifyIntent(i).intent, ADVERSARIAL_SET);
const pass = results.filter((r) => r.passed).length;
const threw = results.filter((r) => r.threw).length;

console.log('=== ADVERSARIAL EVAL ===');
for (const r of results) console.log(`${r.passed ? 'PASS' : 'FAIL'}  ${r.id.padEnd(24)} ${r.detail}`);
console.log('');
console.log(`overall: ${pass}/${results.length}   threw: ${threw}`);
