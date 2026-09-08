import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ADAPTER_POPULATED_FIELDS, POLICY_INPUTS, cannotEverFire, unsupportedFields,
} from '../src/policy/inputs.js';
import { defaultPolicy } from '../src/policy/schema.js';

/**
 * THE CLASS, NOT THE INSTANCE.
 *
 * `context.warn_pct` shipped in the default policy for months, printed in `usewarden policy`, and
 * could never fire, because no adapter populates `NormalizedEvent.contextFill`. It survived a green
 * suite because the unit test supplied the field the product never does — the test proved the LOGIC
 * was right and said nothing about whether the INPUT ever arrives (D-224).
 *
 * Fixing that one rule is cheap and worth nothing on its own: the next rule can be added the same
 * way tomorrow. This file is the control. It:
 *
 *   1. derives, by scanning the adapters, which event fields are actually populated, and asserts
 *      the declaration in `src/policy/inputs.ts` matches — so the declaration cannot rot;
 *   2. enumerates every ACTIVE element of the default policy and fails if any of them depends on a
 *      field outside that set.
 *
 * If (2) ever fails, the rule is either wired to a real input or removed from the default. There is
 * no third option, and "it is covered by a unit test" is not one of them.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

/**
 * Every `NormalizedEvent` field an adapter assigns, read out of the source.
 *
 * Two forms are recognised, and both are how the adapters actually write it today:
 *   `sessionId: str(...)`   inside the NormalizedEvent object literal
 *   `ev.command = cmd`      conditional assignment afterwards
 */
function fieldsPopulatedByAdapters(): Set<string> {
  const dir = path.join(SRC, 'adapters');
  const found = new Set<string>();
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.ts')) continue;
      const src = fs.readFileSync(full, 'utf8');
      // Only the object literal that is TYPED as a NormalizedEvent, so an unrelated `command:`
      // (the hook registration in claude.ts builds one) cannot be mistaken for an event field.
      for (const m of src.matchAll(/const\s+\w+\s*:\s*NormalizedEvent\s*=\s*\{([\s\S]*?)\n\s*\};/g)) {
        for (const f of (m[1] ?? '').matchAll(/^\s*([A-Za-z_]\w*)\s*:/gm)) found.add(f[1]!);
      }
      for (const m of src.matchAll(/\bev\.([A-Za-z_]\w*)\s*=/g)) found.add(m[1]!);
    }
  };
  walk(dir);
  return found;
}

describe('policy inputs: no rule may ship that cannot fire', () => {
  test('THE SCAN LANDS: it finds the fields the adapters demonstrably do set', () => {
    // A scan that silently found nothing would make every later assertion vacuous - the shape of
    // "the test passed because the setup failed" this project keeps writing tests against.
    const found = fieldsPopulatedByAdapters();
    assert.ok(found.size >= 8, `the adapter scan found only ${found.size} fields; it is not working`);
    for (const known of ['sessionId', 'cwd', 'command', 'filePath', 'prompt']) {
      assert.ok(found.has(known), `the scan missed \`${known}\`, which normalizeCommon clearly sets`);
    }
  });

  test('the declared ADAPTER_POPULATED_FIELDS matches what the adapters really do', () => {
    // The runtime reads a declaration because a packaged install has no src/ to scan. This is what
    // keeps that declaration true.
    const found = fieldsPopulatedByAdapters();
    const declared = new Set<string>(ADAPTER_POPULATED_FIELDS as readonly string[]);
    const missingFromDeclaration = [...found].filter((f) => !declared.has(f)).sort();
    const overclaimed = [...declared].filter((f) => !found.has(f)).sort();
    assert.deepEqual(missingFromDeclaration, [],
      `adapters now set fields the declaration omits: ${missingFromDeclaration.join(', ')}`);
    assert.deepEqual(overclaimed, [],
      `the declaration claims fields no adapter sets: ${overclaimed.join(', ')}. `
      + 'That is the D-224 defect exactly - update src/policy/inputs.ts.');
  });

  test('EVERY ACTIVE ELEMENT OF THE DEFAULT POLICY DEPENDS ONLY ON FIELDS THAT ARRIVE', () => {
    const p = defaultPolicy('/repo');
    const active: string[] = [];
    if (p.scope.forbidden_paths.length > 0) active.push('scope.forbidden_paths');
    if (p.scope.allowed_paths.length > 0) active.push('scope.allowed_paths');
    if (p.scope.protect_uncommitted) active.push('scope.protect_uncommitted');
    if (p.commands.deny.length > 0) active.push('commands.deny');
    if (p.protected_branches.length > 0) active.push('protected_branches');
    if (p.context.warn_pct !== null) active.push('context.warn_pct');
    if (p.session.goal_required) active.push('session.goal_required');
    if (p.invariants.length > 0) active.push('invariants');

    const dead = active.filter((s) => cannotEverFire(s));
    assert.deepEqual(dead, [],
      'these are ON in the DEFAULT policy and cannot fire, because no adapter populates their '
      + `input: ${dead.map((s) => `${s} (needs ${unsupportedFields(s).join(', ')})`).join('; ')}. `
      + 'Wire the input, or take the rule out of the default and document it as opt-in. A rule a '
      + 'user can read in their own policy but which cannot fire is a protection they do not have.');
  });

  test('every policy section that exists is covered by the registry — no rule escapes the check', () => {
    // The check above can only protect sections the registry knows about, so a new rule added
    // without a registry entry would slip past it. This asserts the registry is exhaustive.
    const p = defaultPolicy('/repo');
    const sections = new Set(POLICY_INPUTS.map((x) => x.section));
    const expected = ['scope.forbidden_paths', 'scope.allowed_paths', 'scope.protect_uncommitted',
      'commands.deny', 'protected_branches', 'context.warn_pct', 'session.goal_required', 'invariants'];
    for (const e of expected) {
      assert.ok(sections.has(e), `POLICY_INPUTS has no entry for ${e}`);
    }
    // And the policy object has no top-level key that is neither covered nor deliberately exempt.
    // `version`, `judge` and `telemetry` are configuration, not rules that evaluate an event.
    //
    // `backup` was added in the same spirit and this control caught it on the first run, which is
    // the control working: it reads no field of a NormalizedEvent and produces no verdict, so it
    // cannot be a rule that silently cannot fire. What it CAN do is fail to fire for a different
    // reason - an unset destination - and that is covered in tests/backup.test.ts by asserting it
    // is off by default and by exercising both the throttled and the due paths.
    const exempt = new Set(['version', 'judge', 'telemetry', 'checkpoint', 'backup']);
    for (const key of Object.keys(p)) {
      if (exempt.has(key)) continue;
      const covered = [...sections].some((s) => s === key || s.startsWith(`${key}.`));
      assert.ok(covered, `policy key "${key}" is neither in POLICY_INPUTS nor exempt. `
        + 'Add it to the registry so the cannot-fire check covers it.');
    }
  });

  test('the D-224 rule specifically is OFF by default and stays diagnosable', () => {
    assert.equal(defaultPolicy('/repo').context.warn_pct, null,
      'context.warn_pct must not ship enabled while contextFill is unpopulated');
    assert.equal(cannotEverFire('context.warn_pct'), true);
    assert.deepEqual(unsupportedFields('context.warn_pct'), ['contextFill']);
  });

  test('a section losing ONE of several inputs is narrowed, not killed', () => {
    // scope.forbidden_paths reads filePath OR command and fires on either. The check must not
    // report it dead just because one input went away, or the control would cry wolf and be
    // switched off - which is how a guard stops being read.
    assert.equal(cannotEverFire('scope.forbidden_paths'), false);
  });
});
