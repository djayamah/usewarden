/**
 * `usewarden replay` - re-run the stored corpus against a ruleset.
 *
 * Kept out of cli.ts because it is the only command that loads the label machinery, and cli.ts is
 * already 1,200 lines. It is imported dynamically from the dispatch table for the same reason
 * `demo` and `dashboard` are: nothing here should cost a millisecond on the hook path.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Store } from './store.js';
import type { ReplayableAction } from './types.js';
import { loadPolicy, parsePolicyFile } from './policy/load.js';
import type { Policy } from './policy/schema.js';
import { replayCorpus, summarise, renderAction, type ReplayResult } from './replay.js';
import { readLabelSet, verifyLabels, score, pct, type LabelSet } from './labels.js';
import { bad, dim, head, ok, warn } from './term.js';
import type { IncidentOrigin } from './types.js';

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  const withEq = argv.find((a) => a.startsWith(`${name}=`));
  return withEq ? withEq.slice(name.length + 1) : undefined;
}

export async function cmdReplay(argv: string[], json: boolean): Promise<number> {
  const originArg = flagValue(argv, '--origin') ?? 'live';
  const policyFile = flagValue(argv, '--policy');
  const labelsFile = flagValue(argv, '--labels');
  const changedOnly = argv.includes('--changed-only');
  const showAll = argv.includes('--all');

  const origin = originArg === 'all' ? undefined : (originArg as IncidentOrigin);

  const store = new Store();
  const rows = store.replayCorpus(origin);

  let policy: Policy;
  let policySource: string;
  if (policyFile) {
    policy = parsePolicyFile(policyFile);
    policySource = policyFile;
  } else {
    const loaded = loadPolicy(process.cwd());
    policy = loaded.policy;
    policySource = loaded.sources.join(' + ');
  }

  const results = replayCorpus(rows, policy);
  const summary = summarise(results);

  // The action currently in the corpus for each id, so a label set can be bound to it.
  const actions = new Map<number, ReplayableAction>();
  for (const r of rows) if (r.replayable) actions.set(r.id, r.replayable);

  const blockedById = new Map<number, boolean | null>();
  for (const r of results) blockedById.set(r.id, r.blockedNow);
  const thenById = new Map<number, boolean>();
  for (const r of results) thenById.set(r.id, r.blockedThen);

  let labelBlock: Record<string, unknown> | undefined;
  let labelLines: string[] = [];
  if (labelsFile) {
    if (!fs.existsSync(labelsFile)) {
      process.stderr.write(`${bad('replay: label set not found:')} ${labelsFile}\n`);
      return 1;
    }
    const { set, expected } = readLabelSet(labelsFile);
    const v = verifyLabels(set, expected, actions);
    if (!v.ok) {
      // REFUSED, not warned. A precision number computed from an unverified label set is worse
      // than no number, because it looks exactly like a verified one on a slide.
      process.stderr.write(`${bad('replay: REFUSING this label set.')}\n`);
      for (const p of v.problems) process.stderr.write(`  - ${p}\n`);
      process.stderr.write(dim(`  computed ${v.hash}\n  frozen   ${v.expected || '(no FROZEN.sha256 beside the label file)'}\n`));
      if (json) process.stdout.write(`${JSON.stringify({ ok: false, problems: v.problems, hash: v.hash, expected: v.expected }, null, 2)}\n`);
      return 1;
    }
    const now = score(set, (id) => blockedById.get(id) ?? null);
    const then = score(set, (id) => thenById.get(id) ?? null);
    labelBlock = {
      file: path.relative(process.cwd(), labelsFile),
      hash: v.hash,
      labelledAt: set.labelledAt,
      before: then,
      after: now,
    };
    labelLines = renderScores(set, then, now);
  }

  if (json) {
    process.stdout.write(`${JSON.stringify({
      policy: policySource,
      corpus: { origin: originArg, source: store.path },
      summary,
      ...(labelBlock ? { labels: labelBlock } : {}),
      results,
    }, null, 2)}\n`);
    return 0;
  }

  const out: string[] = [];
  out.push(head(`usewarden replay — ${summary.total} stored incidents (origin: ${originArg})`));
  out.push(dim(`  corpus  ${store.path}`));
  out.push(dim(`  rules   ${policySource}`));
  out.push('');

  const shown = results.filter((r) => {
    if (showAll) return true;
    if (changedOnly) return r.outcome !== 'same';
    return true;
  });

  for (const r of shown) out.push(...renderResult(r, rows.find((x) => x.id === r.id)?.replayable));
  if (shown.length > 0) out.push('');

  out.push(head('SUMMARY'));
  out.push(`  blocked then          ${summary.blockedThen}`);
  out.push(`  blocked now           ${summary.blockedNow}`);
  out.push(`  unchanged             ${summary.byOutcome.same}`);
  out.push(`  now allowed           ${summary.byOutcome['now-allowed']}`);
  out.push(`  newly blocked         ${summary.byOutcome['now-blocked']}`);
  out.push(`  same block, new rule  ${summary.byOutcome['rule-changed']}`);
  // Both are failures of the replay, so both are named even when zero. A line that only appears
  // when it is non-zero teaches a reader that its absence means nothing was checked.
  out.push(`  ${summary.indeterminate > 0 ? warn('indeterminate') : 'indeterminate'}         ${summary.indeterminate}${summary.indeterminate ? '  (a deciding rule could not be evaluated)' : ''}`);
  out.push(`  ${summary.unreplayable > 0 ? warn('UNREPLAYABLE') : 'unreplayable'}          ${summary.unreplayable}${summary.unreplayable ? '  (no faithful input exists for these)' : ''}`);

  if (labelLines.length > 0) { out.push(''); out.push(...labelLines); }

  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
}

function renderResult(r: ReplayResult, action?: ReplayableAction): string[] {
  const tag =
    r.outcome === 'now-allowed' ? ok('now allowed ') :
    r.outcome === 'now-blocked' ? warn('newly blocked') :
    r.outcome === 'rule-changed' ? warn('rule changed') :
    r.outcome === 'unreplayable' ? bad('UNREPLAYABLE') :
    r.outcome === 'indeterminate' ? bad('indeterminate') :
    dim('unchanged   ');
  const line = action ? renderAction(action, 96) : r.attempted.slice(0, 96);
  const rules = r.blockedNow === null
    ? `${r.ruleThen} → ${r.note ?? '?'}`
    : r.blockedNow
      ? `${r.ruleThen} → ${r.ruleNow}`
      : `${r.ruleThen} → allow`;
  return [
    `  ${tag} ${dim(`#${String(r.id).padStart(3)}`)} ${line}`,
    `                ${dim(rules)}`,
  ];
}

function renderScores(set: LabelSet, before: ReturnType<typeof score>, after: ReturnType<typeof score>): string[] {
  const l: string[] = [];
  l.push(head('PRECISION AND COVERAGE, against the frozen label set'));
  l.push(dim(`  labels  ${set.labels.length} incidents, labelled ${set.labelledAt}`));
  l.push('');
  l.push(`  ${' '.repeat(22)}${'BEFORE (as recorded)'.padEnd(24)}AFTER (rules under test)`);
  l.push(`  ${'precision'.padEnd(22)}${`${pct(before.precision)}  (${before.truePositives}/${before.truePositives + before.falsePositives})`.padEnd(24)}${pct(after.precision)}  (${after.truePositives}/${after.truePositives + after.falsePositives})`);
  l.push(`  ${'coverage'.padEnd(22)}${`${pct(before.coverage)}  (${before.coverageCaught}/${before.coverageTotal})`.padEnd(24)}${pct(after.coverage)}  (${after.coverageCaught}/${after.coverageTotal})`);
  l.push(`  ${'false positives'.padEnd(22)}${String(before.falsePositives).padEnd(24)}${after.falsePositives}`);
  l.push(`  ${'unknown, still firing'.padEnd(22)}${String(before.unknown).padEnd(24)}${after.unknown}`);
  l.push(`  ${'indeterminate'.padEnd(22)}${String(before.indeterminate).padEnd(24)}${after.indeterminate}`);
  l.push('');
  // The one sentence this whole command exists to be able to say honestly.
  if (after.coverage !== null && before.coverage !== null && after.coverage < before.coverage) {
    l.push(bad(`  COVERAGE REGRESSION: ${before.coverageCaught - after.coverageCaught} real catch(es) no longer fire.`));
    l.push(bad('  A precision gain that costs coverage is a regression, not an improvement.'));
  }
  return l;
}
