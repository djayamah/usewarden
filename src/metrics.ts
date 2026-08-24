import type { IncidentOrigin } from './types.js';
import { INCIDENT_ORIGINS } from './types.js';
import type { Store } from './store.js';

/**
 * The single source of truth for every number usewarden reports.
 *
 * ------------------------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ------------------------------------------------------------------------------------------
 * Until schema v2 the headline figures were read straight out of the `counters` table: a set of
 * free-running integers bumped as events arrived. Three consecutive `usewarden demo` runs on a
 * brand-new install therefore produced "12 actions blocked" from zero real agent sessions, next
 * to "8 events inspected" - more blocks than events, because events deduplicated a replay and
 * incidents did not. That artifact is kept at `verification/metrics-inflation-before.txt`.
 *
 * "Actions blocked" is the number on the dashboard, in the status line, and in every screenshot
 * this product would ever be judged by. A number like that has to be one that neither the user
 * nor usewarden itself can accidentally inflate. So:
 *
 *   1. Every figure here is DERIVED by query from the incidents / events / sessions tables.
 *      Nothing is read from a monotonic counter. A derived number can be recomputed, audited,
 *      and corrected; a counter can only ever be wrong forever.
 *   2. Every figure is computed PER ORIGIN. `live` is the only origin the headline uses. Demo
 *      and fixture figures are still reported, but always under their own label.
 *   3. Incidents are deduplicated at write time (see `Store.addIncident`), so one logical
 *      action delivered twice is one attempt.
 *   4. `attempts` and `distinct_actions` are reported separately. An agent that retries the same
 *      forbidden read five times made five attempts against one distinct action, and the second
 *      of those is the honest number to put on a slide.
 *   5. `integrity` re-checks the arithmetic on every read and names anything impossible.
 *
 * The savings estimate below is an ESTIMATE and says so everywhere it appears. Spec 3.6:
 * "estimation method documented honestly - no invented precision." Full method, including every
 * constant and how to recompute it with your own numbers: docs/METRICS.md.
 */

export interface Breakdown {
  /** Incidents whose action was `block`. Retries count. */
  attempts: number;
  /** Distinct (rule, tool, target) triples blocked. Retries collapse. The honest headline. */
  distinct_actions: number;
  /** Layer-2 findings. Always warnings - Layer 2 never blocks. */
  drift_warnings: number;
  /** Non-blocking guidance: context-fill advice and the like. */
  advisories: number;
  /** Every incident row of this origin, whatever its severity. */
  incidents: number;
  sessions: number;
  events: number;
}

/** What kind of harm a blocked action was heading for. Drives the savings method. */
export type Category = 'out_of_scope_write' | 'destructive' | 'drift' | 'credential_exposure' | 'shell_execution' | 'other';

export interface Band { low: number; high: number }

export interface Savings {
  /** Method id, bumped whenever a constant changes, so an old figure is never mistaken for a new one. */
  method: string;
  /** Distinct live actions the token estimate is computed from. */
  priced_actions: number;
  /**
   * Distinct live actions deliberately NOT priced: credential exposure and shell execution.
   * Putting a dollar figure on "your API key did not leak" would be the invented precision the
   * spec forbids. They are counted and named, never converted.
   */
  unpriced_actions: number;
  tokens: Band;
  usd: Band;
  by_category: Record<Category, number>;
  reference: {
    model: string;
    input_per_mtok: number;
    output_per_mtok: number;
    input_share: number;
    priced_on: string;
    source: string;
  };
  per_action_tokens: Record<Category, Band | null>;
  /** Always false in v1. Flips only when the bands come from measurement, not assumption. */
  measured: boolean;
  caveats: string[];
}

export interface Overhead {
  judge_calls: number;
  metered_usd: number;
  unmetered_calls: number;
  mocked_calls: number;
  in_tokens: number;
  out_tokens: number;
}

export interface Metrics {
  live: Breakdown;
  demo: Breakdown;
  fixture: Breakdown;
  total: Breakdown;
  savings: Savings;
  overhead: Overhead;
  /** Raw monotonic counters, kept for debugging. NEVER the source of a reported figure. */
  raw_counters: Record<string, number>;
  integrity: { consistent: boolean; problems: string[] };
}

// ---------------------------------------------------------------------------------------------
// The estimation constants. Every one of these is an ASSUMPTION. docs/METRICS.md states the
// reasoning for each, and `usewarden metrics --json` prints them so anyone can substitute their
// own and recompute. Changing any number here means bumping METHOD.
// ---------------------------------------------------------------------------------------------

export const METHOD = 'distinct-live-blocked-actions/v1';

/**
 * Marginal tokens for one agent tool-call turn: what the agent generates plus the tool result
 * it reads back, NOT the whole resent context. Band, not a point.
 */
export const TURN_TOKENS: Band = { low: 1_000, high: 4_000 };

/**
 * How many wasted turns one blocked action of each category would have cost, low to high.
 *
 * The high bound for `drift` is not a guess pulled from the air: it is one Layer-2 trigger
 * window. `judge.every_n_events` defaults to 15, so 15 turns is, by construction, the longest a
 * drift can run before usewarden's own sampled judge would have looked at it anyway.
 */
export const TURNS_WASTED: Record<Category, Band | null> = {
  out_of_scope_write: { low: 1, high: 3 },
  destructive: { low: 2, high: 10 },
  drift: { low: 2, high: 15 },
  credential_exposure: null,
  shell_execution: null,
  other: null,
};

/**
 * Reference price. Re-checked against the vendor's published pricing page on `priced_on`; the
 * figure is an estimate at those rates and is labelled as one everywhere it is shown.
 *
 * `input_share` is the assumption that agent turns are input-heavy, because the full context is
 * resent every turn while the model writes comparatively little.
 */
export const REFERENCE_PRICE = {
  model: 'claude-sonnet-5',
  input_per_mtok: 2.00,
  output_per_mtok: 10.00,
  input_share: 0.8,
  priced_on: '2026-08-20',
  source: 'https://platform.claude.com/docs/en/about-claude/pricing',
} as const;

/** Blended USD per million tokens at the reference price and the stated input/output split. */
export function blendedPerMTok(): number {
  const p = REFERENCE_PRICE;
  return p.input_share * p.input_per_mtok + (1 - p.input_share) * p.output_per_mtok;
}

/**
 * Maps a policy rule id onto a harm category. Rule ids are usewarden's own vocabulary; anything
 * unrecognised falls through to `other`, which is counted and never priced. Unknown means
 * unpriced, never "probably worth something".
 */
export function categorise(rule: string, layer: number): Category {
  if (layer === 2) return 'drift';
  const id = rule.toLowerCase();
  if (id.includes('forbidden_paths') || id.includes('dotenv')) return 'credential_exposure';
  if (id.includes('curl-pipe-sh') || id.includes('sudo')) return 'shell_execution';
  if (id.includes('allowed_paths') || id.includes('sibling')) return 'out_of_scope_write';
  if (id.includes('protected_branch') || id.includes('force-push') || id.includes('rm-rf')
    || id.includes('reset-hard') || id.includes('drop-table')) return 'destructive';
  return 'other';
}

function emptyBreakdown(): Breakdown {
  return { attempts: 0, distinct_actions: 0, drift_warnings: 0, advisories: 0, incidents: 0, sessions: 0, events: 0 };
}

function breakdownFor(store: Store, origin: IncidentOrigin): Breakdown {
  const one = (sql: string, ...p: unknown[]): number => {
    const r = store.db.prepare(sql).get(...(p as never[])) as { c: number } | undefined;
    return Number(r?.c ?? 0);
  };
  return {
    attempts: one(`SELECT COUNT(*) AS c FROM incidents WHERE origin=? AND action='block'`, origin),
    distinct_actions: one(
      `SELECT COUNT(*) AS c FROM (SELECT DISTINCT rule,tool,target FROM incidents WHERE origin=? AND action='block')`, origin),
    drift_warnings: one(`SELECT COUNT(*) AS c FROM incidents WHERE origin=? AND layer=2`, origin),
    advisories: one(`SELECT COUNT(*) AS c FROM incidents WHERE origin=? AND action='compact-advice'`, origin),
    incidents: one(`SELECT COUNT(*) AS c FROM incidents WHERE origin=?`, origin),
    sessions: store.countSessions(origin),
    events: store.countEvents(origin),
  };
}

function sumBreakdowns(parts: Breakdown[]): Breakdown {
  const t = emptyBreakdown();
  for (const p of parts) {
    t.attempts += p.attempts;
    t.drift_warnings += p.drift_warnings;
    t.advisories += p.advisories;
    t.incidents += p.incidents;
    t.sessions += p.sessions;
    t.events += p.events;
    // distinct_actions is NOT additive across origins - the same action can appear in more than
    // one origin - so it is recomputed by the caller against the whole table.
  }
  return t;
}

/**
 * The savings estimate, computed from LIVE distinct blocked actions only.
 *
 * Demo actions are excluded because they are not real, and repeat attempts are excluded because
 * blocking the same forbidden read five times did not save five recoveries.
 */
export function estimateSavings(store: Store): Savings {
  const rows = store.db.prepare(
    `SELECT DISTINCT rule, tool, target, layer FROM incidents
     WHERE origin='live' AND (action='block' OR layer=2)`).all() as
    { rule: string; tool: string; target: string; layer: number }[];

  const byCategory: Record<Category, number> = {
    out_of_scope_write: 0, destructive: 0, drift: 0, credential_exposure: 0, shell_execution: 0, other: 0,
  };
  let low = 0;
  let high = 0;
  let priced = 0;
  let unpriced = 0;
  for (const r of rows) {
    const cat = categorise(r.rule, Number(r.layer));
    byCategory[cat] += 1;
    const turns = TURNS_WASTED[cat];
    if (!turns) { unpriced += 1; continue; }
    priced += 1;
    low += turns.low * TURN_TOKENS.low;
    high += turns.high * TURN_TOKENS.high;
  }

  const perMTok = blendedPerMTok();
  return {
    method: METHOD,
    priced_actions: priced,
    unpriced_actions: unpriced,
    tokens: { low, high },
    usd: { low: (low / 1_000_000) * perMTok, high: (high / 1_000_000) * perMTok },
    by_category: byCategory,
    reference: {
      model: REFERENCE_PRICE.model,
      input_per_mtok: REFERENCE_PRICE.input_per_mtok,
      output_per_mtok: REFERENCE_PRICE.output_per_mtok,
      input_share: REFERENCE_PRICE.input_share,
      priced_on: REFERENCE_PRICE.priced_on,
      source: REFERENCE_PRICE.source,
    },
    per_action_tokens: {
      out_of_scope_write: bandTokens('out_of_scope_write'),
      destructive: bandTokens('destructive'),
      drift: bandTokens('drift'),
      credential_exposure: null,
      shell_execution: null,
      other: null,
    },
    measured: false,
    caveats: [
      'ESTIMATE, not a measurement. The per-action bands are assumptions; docs/METRICS.md states each one.',
      'Counted from DISTINCT blocked actions in REAL agent sessions only. Demo runs and repeat attempts are excluded.',
      'Credential exposure and shell execution are counted but never priced - a dollar figure for "your key did not leak" would be invented precision.',
      'If your agent runs on a subscription plan, this is quota, not dollars.',
      `Priced at ${REFERENCE_PRICE.model} rates checked on ${REFERENCE_PRICE.priced_on}. Your model and rate will differ.`,
    ],
  };
}

function bandTokens(cat: Category): Band | null {
  const t = TURNS_WASTED[cat];
  if (!t) return null;
  return { low: t.low * TURN_TOKENS.low, high: t.high * TURN_TOKENS.high };
}

/**
 * Arithmetic that must hold for the numbers to mean anything. Each violation is reported in
 * words, because "the guardian's own figures do not add up" is exactly the kind of thing a
 * boolean hides. `usewarden doctor` fails on a non-empty list.
 */
function checkIntegrity(m: Omit<Metrics, 'integrity'>): { consistent: boolean; problems: string[] } {
  const problems: string[] = [];
  for (const o of INCIDENT_ORIGINS) {
    const b = m[o];
    /**
     * `b.events > 0` is a real exemption, not a fudge: an incident can legitimately exist with
     * no matching event row. Tests call `addIncident` directly, and a database migrated from
     * schema v1 holds incidents whose events predate the origin column entirely. What this
     * check is for is the case that actually shipped - blocks OUTNUMBERING events that were
     * genuinely recorded - and that case always has events on both sides of the comparison.
     */
    if (b.attempts > b.events && b.events > 0) {
      problems.push(`${o}: ${b.attempts} blocked attempts against only ${b.events} inspected events - usewarden cannot block what it never saw`);
    }
    if (b.distinct_actions > b.attempts) {
      problems.push(`${o}: ${b.distinct_actions} distinct actions from ${b.attempts} attempts - distinct can never exceed total`);
    }
    if (b.incidents < b.attempts || b.incidents < b.drift_warnings) {
      problems.push(`${o}: incident total ${b.incidents} is smaller than its own parts (${b.attempts} blocks, ${b.drift_warnings} drift)`);
    }
  }
  if (m.savings.tokens.low > m.savings.tokens.high) {
    problems.push('savings: the low estimate exceeds the high estimate');
  }
  if (m.savings.priced_actions > m.live.distinct_actions + m.live.drift_warnings) {
    problems.push(`savings: ${m.savings.priced_actions} priced actions from ${m.live.distinct_actions} distinct live blocks - the estimate is drawing on something that is not a live catch`);
  }
  return { consistent: problems.length === 0, problems };
}

export function buildMetrics(store: Store): Metrics {
  const live = breakdownFor(store, 'live');
  const demo = breakdownFor(store, 'demo');
  const fixture = breakdownFor(store, 'fixture');

  const total = sumBreakdowns([live, demo, fixture]);
  const distinctAll = store.db.prepare(
    `SELECT COUNT(*) AS c FROM (SELECT DISTINCT rule,tool,target FROM incidents WHERE action='block')`)
    .get() as { c: number };
  total.distinct_actions = Number(distinctAll.c);

  const spend = store.totalJudgeSpend();
  const partial: Omit<Metrics, 'integrity'> = {
    live, demo, fixture, total,
    savings: estimateSavings(store),
    overhead: {
      judge_calls: spend.calls,
      metered_usd: spend.usd,
      unmetered_calls: spend.unmetered,
      mocked_calls: spend.mocked,
      in_tokens: spend.inTok,
      out_tokens: spend.outTok,
    },
    raw_counters: store.allCounters(),
  };
  return { ...partial, integrity: checkIntegrity(partial) };
}

/** `12,345` - the only number formatting usewarden does, so every surface agrees. */
export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/**
 * Renders a token band the way it must always be shown: as a range, with the word "est.".
 * There is deliberately no function anywhere that renders a single savings number.
 */
export function fmtTokenBand(b: Band): string {
  if (b.high === 0) return 'nothing to estimate yet';
  return `${fmtInt(b.low)}-${fmtInt(b.high)} tokens (est.)`;
}

export function fmtUsdBand(b: Band): string {
  if (b.high === 0) return '$0.00 (est.)';
  return `$${b.low.toFixed(2)}-$${b.high.toFixed(2)} (est.)`;
}
