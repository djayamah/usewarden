/**
 * THE FROZEN LABEL SET, and the hash that makes it frozen.
 *
 * WHY A HASH AND NOT A CONVENTION. Precision is TP / (TP + FP). Both terms come from human
 * judgement about individual incidents, so precision is a number anyone can move to any value
 * they like by editing the labels - and the pressure to do exactly that arrives the moment a
 * target is missed. "A precision number you can move by relabelling is not a measurement."
 *
 * So the labels are hashed and the hash is committed separately from the labels. `verifyLabels`
 * refuses a set whose bytes have moved, and refuses one whose entries no longer match the actions
 * they claim to describe. It is not tamper-PROOF - anyone who can edit the labels can edit the
 * frozen hash beside them - and it is not meant to be. It is tamper-EVIDENT: after tuning starts,
 * a relabelling cannot happen quietly, and a diff of `labels/FROZEN.sha256` in the history is a
 * one-line record that it happened at all.
 *
 * The criterion is hashed with the labels, deliberately. Changing the definition of a true
 * positive moves precision exactly as effectively as changing a label does, and it is the more
 * tempting of the two because it reads as a clarification rather than as a correction.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sha256 } from './util.js';
import type { ReplayableAction } from './types.js';

export type Label = 'TRUE_POSITIVE' | 'FALSE_POSITIVE' | 'UNKNOWN';

export interface LabelEntry {
  /** Incident id in the corpus this set was labelled against. */
  id: number;
  label: Label;
  /** One line. Why a competent developer would, or would not, want this stopped. */
  reason: string;
  /** The class this incident belongs to. Groups the report; never affects the score. */
  class?: string;
  /**
   * sha256 of the canonical form of the action that was labelled.
   *
   * This is what binds a label to an ACTION rather than to a row number. Without it the label set
   * could be re-pointed at a different corpus, or the corpus edited under it, and every number
   * downstream would still compute cleanly and mean nothing.
   */
  actionSha: string;
}

export interface LabelSet {
  /** Free text, hashed with the labels. See the note above. */
  criterion: string;
  labelledAt: string;
  corpus: { origin: string; count: number; source: string };
  labels: LabelEntry[];
}

/**
 * The canonical byte form a hash is taken over.
 *
 * Explicitly NOT `JSON.stringify(set)`: key order in a JSON object is an implementation detail of
 * whoever wrote the file, and a re-serialisation that reordered keys would break the hash without
 * anything having changed. Fields are emitted in a fixed order, labels sorted by id.
 */
export function canonicalise(set: LabelSet): string {
  const labels = [...set.labels].sort((a, b) => a.id - b.id).map((l) => [
    l.id, l.label, l.reason, l.class ?? '', l.actionSha,
  ]);
  return JSON.stringify([
    set.criterion.trim(),
    set.corpus.origin, set.corpus.count, set.corpus.source,
    labels,
  ]);
}

export function labelSetHash(set: LabelSet): string {
  return sha256(Buffer.from(canonicalise(set), 'utf8'));
}

/**
 * The canonical form of an ACTION, for `actionSha`.
 *
 * Only the fields that can change a Layer 1 verdict are included. `ts` and `sessionId` are not:
 * they identify the incident, not the action, and including them would make the label set fail to
 * verify against a corpus copy that had been re-imported.
 */
export function actionHash(a: ReplayableAction): string {
  const canon = JSON.stringify([
    a.agent, a.event, a.tool ?? '', a.rawTool ?? '',
    a.command ?? '', a.filePath ?? '', a.cwd, a.repoRoot ?? '',
    a.prompt ?? '', a.branch ?? '',
  ]);
  return sha256(Buffer.from(canon, 'utf8'));
}

export interface VerifyResult {
  ok: boolean;
  /** Every reason the set was refused. Empty when `ok`. */
  problems: string[];
  hash: string;
  expected: string;
}

/**
 * Refuses a label set whose bytes, criterion, or bound actions have moved.
 *
 * `actions` maps incident id to the action currently in the corpus. Pass an empty map to check
 * only the file hash - `usewarden replay` always passes the real one.
 */
export function verifyLabels(
  set: LabelSet,
  expected: string,
  actions: ReadonlyMap<number, ReplayableAction>,
): VerifyResult {
  const problems: string[] = [];
  const hash = labelSetHash(set);
  if (hash !== expected) {
    problems.push(`label set hash ${hash.slice(0, 16)}… does not match the frozen ${expected.slice(0, 16)}…`);
  }
  if (actions.size > 0) {
    let missing = 0, moved = 0;
    for (const l of set.labels) {
      const a = actions.get(l.id);
      if (!a) { missing++; continue; }
      if (actionHash(a) !== l.actionSha) moved++;
    }
    if (missing > 0) problems.push(`${missing} labelled incident(s) are not in this corpus`);
    if (moved > 0) problems.push(`${moved} labelled action(s) no longer hash to what was labelled`);
  }
  return { ok: problems.length === 0, problems, hash, expected };
}

export function readLabelSet(file: string): { set: LabelSet; expected: string } {
  const set = JSON.parse(fs.readFileSync(file, 'utf8')) as LabelSet;
  const frozen = path.join(path.dirname(file), 'FROZEN.sha256');
  let expected = '';
  if (fs.existsSync(frozen)) {
    // `<hash>  <filename>` — shasum(1)'s LAYOUT, but not a shasum(1) checksum, and the difference
    // matters enough to say here rather than in a README. The hash is over `canonicalise(set)`,
    // not over the file's bytes: key order in JSON is an implementation detail of whoever wrote
    // the file, and a re-serialisation that reordered keys or changed indentation would break a
    // byte hash without anything having changed. `shasum -c FROZEN.sha256` therefore reports
    // FAILED on the label line, correctly — verify with `usewarden replay --labels`, which
    // recomputes the canonical form.
    for (const line of fs.readFileSync(frozen, 'utf8').split('\n')) {
      const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/.exec(line.trim());
      if (m && path.basename(m[2]!) === path.basename(file)) expected = m[1]!;
    }
  }
  return { set, expected };
}

export interface Scored {
  truePositives: number;
  falsePositives: number;
  unknown: number;
  /** null when the denominator is zero - never 0, never 1. */
  precision: number | null;
  /** Of the incidents labelled TRUE_POSITIVE, how many still block. */
  coverageCaught: number;
  coverageTotal: number;
  coverage: number | null;
  /** Labelled incidents whose replay could not produce an answer. Counted, never dropped. */
  indeterminate: number;
}

/**
 * Precision and coverage, together, from one pass.
 *
 * They are returned from ONE function taking ONE input on purpose. The failure this is built
 * against is reporting a precision gain from a run that also dropped real catches, and the
 * cheapest way to do that accidentally is to compute the two numbers in two places from two
 * filters. `blocked(id)` answers "does the ruleset under test block this incident"; `null` means
 * the replay could not tell, and a null is never read as a false.
 */
export function score(
  set: LabelSet,
  blocked: (id: number) => boolean | null,
): Scored {
  let tp = 0, fp = 0, unknown = 0, indeterminate = 0;
  let coverageCaught = 0, coverageTotal = 0;

  for (const l of set.labels) {
    const b = blocked(l.id);
    if (l.label === 'TRUE_POSITIVE') {
      coverageTotal++;
      if (b === true) coverageCaught++;
    }
    if (b === null) { indeterminate++; continue; }
    if (!b) continue;                      // not blocked by this ruleset: not in the precision set
    if (l.label === 'TRUE_POSITIVE') tp++;
    else if (l.label === 'FALSE_POSITIVE') fp++;
    else unknown++;
  }

  const denom = tp + fp;
  return {
    truePositives: tp,
    falsePositives: fp,
    unknown,
    precision: denom === 0 ? null : tp / denom,
    coverageCaught,
    coverageTotal,
    coverage: coverageTotal === 0 ? null : coverageCaught / coverageTotal,
    indeterminate,
  };
}

export function pct(v: number | null): string {
  return v === null ? 'unavailable' : `${(v * 100).toFixed(1)}%`;
}
