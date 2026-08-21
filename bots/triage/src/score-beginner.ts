import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Corpus } from './corpus.js';
import { triage, type Issue } from './triage.js';
import { runBeginnerEval, BEGINNER_SET, type Intent } from './beginner-eval.js';

/**
 * Prints the beginner-eval score. Run before and after a change; both numbers get reported.
 *
 * `--current` scores the bot AS IT BEHAVES, by reading the intent back out of what it did rather
 * than out of a classifier it does not have. That is the honest baseline: the question is not
 * "what would it have classified this as" but "what did it treat this as", and the answer is
 * visible in the route it took and the template it reached for.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** Intent inferred from behaviour, for scoring a bot that classifies nothing. */
export function behaviouralIntent(corpus: Corpus): (i: Issue) => Intent {
  return (issue: Issue): Intent => {
    const r = triage(issue, corpus);
    if (r.route === 'security') return 'security';
    if (r.answer?.answered && r.matches.length === 0) return 'question';
    return 'bug';   // everything else gets the defect-triage template, which IS treating it as a bug
  };
}

async function main(): Promise<void> {
  const corpus = new Corpus(REPO_ROOT);
  const useCurrent = process.argv.includes('--current');
  let intentOf: (i: Issue) => Intent;
  if (useCurrent) {
    intentOf = behaviouralIntent(corpus);
  } else {
    const mod = await import('./intent.js') as { classifyIntent(i: Issue): { intent: Intent } };
    intentOf = (i: Issue) => mod.classifyIntent(i).intent;
  }

  const results = runBeginnerEval(corpus, intentOf, BEGINNER_SET);
  const pass = results.filter((r) => r.passed).length;
  const intentPass = results.filter((r) => r.intentOk).length;

  console.log(`=== BEGINNER EVAL ${useCurrent ? '(current bot, intent read from behaviour)' : '(with intent classifier)'} ===`);
  for (const r of results) {
    console.log(`${r.passed ? 'PASS' : 'FAIL'}  ${r.id.padEnd(22)} ${r.detail}`);
  }
  console.log('');
  console.log(`overall: ${pass}/${results.length}   intent correct: ${intentPass}/${results.length}`);
  process.exitCode = 0;   // reporting a number is not a gate; the gate is in the test suite
}

main().catch((e: Error) => { console.error(e.message); process.exitCode = 1; });
