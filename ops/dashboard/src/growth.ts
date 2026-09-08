import type { DayPoint } from './sources.js';

/**
 * WEEK-OVER-WEEK CHANGE.
 *
 * An investor buys the slope, not the level — but a slope computed from too little history is a
 * number that will be wrong in a way nobody can check. So this returns a discriminated result:
 * either a real change, or a stated reason there is not one yet. There is no third state where a
 * flat line stands in for missing data, because a flat line reads as "measured, and steady".
 */
export type Growth =
  | { available: true; current: number; previous: number; deltaPct: number | null; direction: 'up' | 'down' | 'flat' }
  | { available: false; reason: string };

/** Days of history needed before a week-over-week comparison means anything. */
export const MIN_DAYS_FOR_WOW = 14;

/**
 * Compares the last 7 days against the 7 before them.
 *
 * `deltaPct` is null when the previous week was zero: a rise from nothing is not a percentage,
 * and rendering it as "+∞%" or "+100%" would be inventing a figure. The caller shows the two
 * counts instead.
 */
export function weekOverWeek(series: DayPoint[], pick: (d: DayPoint) => number = (d) => d.uniques): Growth {
  if (series.length < MIN_DAYS_FOR_WOW) {
    return {
      available: false,
      reason: `needs ${MIN_DAYS_FOR_WOW} days of history to compare two weeks; there are ${series.length}`,
    };
  }
  const sorted = [...series].sort((a, b) => a.day.localeCompare(b.day));
  const last7 = sorted.slice(-7).reduce((n, d) => n + pick(d), 0);
  const prev7 = sorted.slice(-14, -7).reduce((n, d) => n + pick(d), 0);

  if (last7 === 0 && prev7 === 0) {
    return { available: false, reason: 'no activity in either week, so there is no trend to report' };
  }
  const deltaPct = prev7 === 0 ? null : ((last7 - prev7) / prev7) * 100;
  return {
    available: true,
    current: last7,
    previous: prev7,
    deltaPct,
    direction: last7 > prev7 ? 'up' : last7 < prev7 ? 'down' : 'flat',
  };
}

/** Renders a growth result the way it must always be shown: with its sign, or with its reason. */
export function formatGrowth(g: Growth): string {
  if (!g.available) return g.reason;
  if (g.deltaPct === null) return `${g.current} this week, up from none last week`;
  const sign = g.deltaPct > 0 ? '+' : '';
  return `${sign}${g.deltaPct.toFixed(0)}% week over week (${g.current} vs ${g.previous})`;
}

/**
 * THE FUNNEL.
 *
 * Installs → sessions protected → first catch → still active at week 2 and week 4. The interesting
 * part of a funnel is where people leave, so every stage carries the drop from the one before it.
 *
 * Only the aggregator can supply most of this — an install that never reports is invisible by
 * design — so unavailable stages say why rather than showing zero. A funnel with fabricated
 * stages is worse than no funnel: it invites a conclusion about retention from data that does not
 * exist.
 */
export interface FunnelStage {
  label: string;
  value: number | null;
  /** Percent of the FIRST stage that reached this one. Null when either end is unknown. */
  ofFirstPct: number | null;
  /** Percent lost between the previous stage and this one. Null when either end is unknown. */
  dropFromPrevPct: number | null;
  unavailableBecause?: string;
  source: string;
}

export interface FunnelInput {
  installs: number | null;
  sessionsProtected: number | null;
  firstCatch: number | null;
  activeWeek2: number | null;
  activeWeek4: number | null;
  source: string;
  unavailableReason?: string;
}

export function buildFunnel(input: FunnelInput): FunnelStage[] {
  const why = input.unavailableReason
    ?? 'needs the telemetry aggregator, which is built but not deployed';
  const raw: [string, number | null][] = [
    ['Installed', input.installs],
    ['Ran a protected session', input.sessionsProtected],
    ['Had a first catch', input.firstCatch],
    ['Still active at week 2', input.activeWeek2],
    ['Still active at week 4', input.activeWeek4],
  ];

  const first = raw[0]![1];
  let prev: number | null = null;
  return raw.map(([label, value]) => {
    const stage: FunnelStage = {
      label,
      value,
      ofFirstPct: value !== null && first !== null && first > 0 ? (value / first) * 100 : null,
      dropFromPrevPct: value !== null && prev !== null && prev > 0 ? ((prev - value) / prev) * 100 : null,
      source: input.source,
      ...(value === null ? { unavailableBecause: why } : {}),
    };
    if (value !== null) prev = value;
    return stage;
  });
}
