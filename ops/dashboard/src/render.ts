import type { GitHubReadings, ImpactReadings, Reading } from './sources.js';

/**
 * Renders the one dashboard for a terminal.
 *
 * Layout is an argument, not decoration. The North Star — installs that produced a first catch —
 * is displayed largest and first, because spec §3B fixes the activation metric as "usewarden
 * caught something in a real session", not "installed". Downloads appear below it, smaller, and
 * carry their caveat inline: they count CI runs, mirrors and cache misses, and they are a traffic
 * number rather than a user number.
 *
 * Every figure prints its source and the moment it describes. An unavailable figure prints why it
 * is unavailable. Nothing is ever substituted, estimated, or carried over from a previous run.
 */

const RESET = '[0m';
const BOLD = '[1m';
const DIM = '[2m';
const GREEN = '[32m';
const YELLOW = '[33m';

function colour(s: string, code: string): string {
  return process.env['NO_COLOR'] || !process.stdout.isTTY ? s : `${code}${s}${RESET}`;
}

function fmt(n: number): string { return n.toLocaleString('en-US'); }

/** Human "how old is this", so a stale number is visibly stale. */
export function age(iso: string | null, now = Date.now()): string {
  if (!iso) return 'unknown';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'unknown';
  const mins = Math.max(0, Math.round((now - t) / 60_000));
  if (mins < 2) return 'just now';
  if (mins < 90) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function line(r: Reading, now: number): string[] {
  const out: string[] = [];
  if (r.value === null) {
    out.push(`  ${r.label.padEnd(34)} ${colour('unavailable', YELLOW)}`);
    if (r.unavailableBecause) out.push(colour(`    why: ${r.unavailableBecause}`, DIM));
  } else {
    out.push(`  ${r.label.padEnd(34)} ${colour(fmt(r.value), BOLD)}`);
    out.push(colour(`    source: ${r.source}   as of: ${age(r.asOf, now)}`, DIM));
  }
  if (r.caveat) out.push(colour(`    note: ${r.caveat}`, DIM));
  return out;
}

export interface DashboardData {
  repo: string;
  pkg: string;
  generatedAt: string;
  impact: ImpactReadings;
  github: GitHubReadings;
  npm: Reading[];
  openIssueTitles: { number: number; title: string; labels: string[] }[];
}

export function renderText(d: DashboardData): string {
  const now = Date.parse(d.generatedAt);
  const out: string[] = [''];

  out.push(colour('  usewarden — one dashboard', BOLD));
  out.push(colour(`  generated ${d.generatedAt}  ·  every number below states its source and age`, DIM));
  out.push('');

  // ---- NORTH STAR, largest -----------------------------------------------------------------
  out.push(colour('  ┌─ NORTH STAR ────────────────────────────────────────────────────┐', DIM));
  const ns = d.impact.installsWithFirstCatch;
  if (ns.value === null) {
    out.push(`  │  ${colour('       —', YELLOW)}`);
    out.push(`  │  ${colour('INSTALLS THAT PRODUCED A FIRST CATCH', BOLD)}`);
    out.push(colour(`  │  not measurable yet: ${ns.unavailableBecause ?? 'unknown'}`, DIM));
  } else {
    out.push(`  │  ${colour(fmt(ns.value).padStart(8), GREEN + BOLD)}`);
    out.push(`  │  ${colour('INSTALLS THAT PRODUCED A FIRST CATCH', BOLD)}`);
    out.push(colour(`  │  source: ${ns.source}  ·  as of ${age(ns.asOf, now)}`, DIM));
    if (ns.caveat) out.push(colour(`  │  ${ns.caveat}`, DIM));
  }
  out.push(colour('  └─────────────────────────────────────────────────────────────────┘', DIM));
  out.push(colour('  This is the metric the product is judged by: not installs, but installs where', DIM));
  out.push(colour('  usewarden actually caught something in a real session.', DIM));
  out.push('');

  out.push(colour('  IMPACT', BOLD));
  for (const r of [d.impact.interventions, d.impact.correctionRate]) out.push(...line(r, now));
  out.push('');

  out.push(colour('  REACH  ' + colour('(secondary — traffic, not users)', DIM), BOLD));
  for (const r of d.npm) out.push(...line(r, now));
  for (const r of [d.github.stars, d.github.forks, d.github.watchers,
    d.github.uniqueCloners14d, d.github.clones14d, d.github.uniqueVisitors14d, d.github.views14d]) {
    out.push(...line(r, now));
  }
  if (d.github.referrers.length > 0) {
    out.push('');
    out.push(colour('  TOP REFERRERS (14d)', BOLD));
    for (const r of d.github.referrers.slice(0, 6)) {
      out.push(`    ${r.name.padEnd(30)} ${fmt(r.uniques)} unique / ${fmt(r.count)} total`);
    }
  }
  out.push('');

  out.push(colour('  OPEN ISSUES', BOLD));
  out.push(...line(d.github.openIssues, now));
  if (d.openIssueTitles.length === 0) {
    out.push(colour('    (none open, or not readable)', DIM));
  } else {
    for (const i of d.openIssueTitles.slice(0, 10)) {
      const labels = i.labels.length > 0 ? colour(`  [${i.labels.join(', ')}]`, DIM) : '';
      out.push(`    #${String(i.number).padEnd(5)} ${i.title.slice(0, 66)}${labels}`);
    }
  }
  out.push('');

  if (d.github.rateRemaining) {
    out.push(colour(`  GitHub API calls remaining this hour: ${d.github.rateRemaining}`, DIM));
  }
  out.push(colour('  Nothing here is cached, estimated, or carried over. A figure that could not be', DIM));
  out.push(colour('  fetched says "unavailable" and why — it is never shown as zero.', DIM));
  out.push('');
  return out.join('\n');
}
