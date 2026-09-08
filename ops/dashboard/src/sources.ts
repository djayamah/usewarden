/**
 * DATA SOURCES for the one dashboard.
 *
 * Endpoints verified against primary documentation on 2026-08-20:
 *   - npm downloads: https://github.com/npm/registry/blob/main/docs/download-counts.md
 *       point:  GET https://api.npmjs.org/downloads/point/{period}/{package}
 *       range:  GET https://api.npmjs.org/downloads/range/{period}/{package}
 *       periods: last-day | last-week | last-month | last-year | YYYY-MM-DD:YYYY-MM-DD
 *       Counts are processed daily after UTC midnight, so "last-day" is typically YESTERDAY.
 *       That lag is surfaced rather than hidden - see `asOf` on every reading.
 *   - GitHub traffic: https://docs.github.com/en/rest/metrics/traffic
 *       /repos/{o}/{r}/traffic/{clones,views,popular/referrers,popular/paths}
 *       Requires WRITE access to the repository. Returns the last 14 days ONLY.
 *
 * Rate limits are not asserted from memory: every GitHub response carries `x-ratelimit-remaining`
 * and the dashboard reports whatever the API actually said.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: every number carries its source and the time it was
 * measured, and a number that could not be fetched is reported as UNAVAILABLE. There is no code
 * path that produces a figure without provenance, and none that substitutes a plausible value.
 */

export interface Reading {
  label: string;
  /** null means genuinely unavailable. It is displayed as such, never as zero. */
  value: number | null;
  /** Where it came from, shown to the reader verbatim. */
  source: string;
  /** What moment the value describes, ISO. Not when we asked - when the data is FROM. */
  asOf: string | null;
  /** Anything the reader must know to not misread the number. */
  caveat?: string;
  /** Why it is unavailable, when it is. */
  unavailableBecause?: string;
}

interface DayPointRaw { timestamp: number | string; count: number; uniques: number }

const NPM_API = 'https://api.npmjs.org';
const GH_API = 'https://api.github.com';

async function getJson(url: string, headers: Record<string, string> = {}):
Promise<{ ok: true; body: unknown; rateRemaining?: string } | { ok: false; status: number; reason: string }> {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'usewarden-dashboard', ...headers } });
    if (!res.ok) return { ok: false, status: res.status, reason: `HTTP ${res.status}` };
    return { ok: true, body: await res.json(), ...(res.headers.get('x-ratelimit-remaining') ? { rateRemaining: res.headers.get('x-ratelimit-remaining')! } : {}) };
  } catch (e) {
    return { ok: false, status: 0, reason: (e as Error).message };
  }
}

/**
 * npm downloads. Absent until the package is published — which is the CURRENT state, and the
 * dashboard says "not published yet" rather than showing a zero that looks like failure.
 */
export async function npmDownloads(pkg: string, period: 'last-day' | 'last-week' | 'last-month'):
Promise<Reading> {
  const source = `api.npmjs.org/downloads/point/${period}/${pkg}`;
  const caveat = 'npm download counts include CI runs, mirrors and cache misses. They are a '
    + 'traffic number, not a user number, and they are processed after UTC midnight so the most '
    + 'recent day is usually yesterday.';
  const r = await getJson(`${NPM_API}/downloads/point/${period}/${encodeURIComponent(pkg)}`);
  if (!r.ok) {
    return {
      label: `npm downloads (${period})`, value: null, source, asOf: null, caveat,
      unavailableBecause: r.status === 404
        ? `\`${pkg}\` is not published to npm yet — this lights up on first publish`
        : r.reason,
    };
  }
  const b = r.body as { downloads?: number; start?: string; end?: string };
  return {
    label: `npm downloads (${period})`,
    value: typeof b.downloads === 'number' ? b.downloads : null,
    source, asOf: b.end ?? null, caveat,
  };
}

/** One day of traffic, for the sparklines. */
export interface DayPoint { day: string; count: number; uniques: number }

/**
 * Is a clone figure plausibly HUMAN?
 *
 * GitHub's traffic API exposes no bot filter and no way to tell a CI runner from a person; the
 * only lever it gives is `uniques`, which is IP-based and therefore merges an office behind one
 * NAT and splits a home connection across several. So this does not claim to detect bots. It
 * checks one thing that is checkable: **a human who clones a repository has almost always looked
 * at its page first.** Clones far exceeding unique visitors is the signature of automation —
 * mirrors, crawlers, dependency scanners, someone's CI.
 *
 * This exists because docs/METRICS.md applies to our own reach figures too. Showing an investor
 * "35 unique cloners" when a knowledgeable person would immediately discount it is exactly the
 * composite-as-strongest-component failure that document forbids.
 */
export function clonePlausibility(uniqueCloners: number | null, uniqueVisitors: number | null):
{ verdict: 'human-plausible' | 'likely-automated' | 'unknown'; note: string } {
  if (uniqueCloners === null || uniqueVisitors === null) {
    return { verdict: 'unknown', note: 'Not enough traffic data to judge.' };
  }
  if (uniqueCloners === 0) return { verdict: 'unknown', note: 'No clones recorded in the window.' };
  if (uniqueVisitors === 0 || uniqueCloners > uniqueVisitors * 3) {
    return {
      verdict: 'likely-automated',
      note: `${uniqueCloners} unique cloners against ${uniqueVisitors} unique page visitors. `
        + 'People almost always look at a repository before cloning it, so a ratio like this is '
        + 'mirrors, crawlers and CI rather than interest. GitHub provides no way to filter bots, '
        + 'so treat clone counts here as traffic, not as people.',
    };
  }
  return {
    verdict: 'human-plausible',
    note: `${uniqueCloners} unique cloners against ${uniqueVisitors} unique visitors. In range for `
      + 'human traffic — though GitHub still offers no bot filter, and uniques are counted by IP.',
  };
}

export interface GitHubReadings {
  stars: Reading;
  forks: Reading;
  watchers: Reading;
  openIssues: Reading;
  clones14d: Reading;
  uniqueCloners14d: Reading;
  views14d: Reading;
  uniqueVisitors14d: Reading;
  referrers: { name: string; count: number; uniques: number }[];
  cloneSeries: DayPoint[];
  viewSeries: DayPoint[];
  plausibility: ReturnType<typeof clonePlausibility>;
  rateRemaining: string | null;
}

export async function githubReadings(repo: string, token?: string): Promise<GitHubReadings> {
  const headers: Record<string, string> = token
    ? { authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' }
    : {};
  const now = new Date().toISOString();
  const unavailable = (label: string, source: string, why: string): Reading =>
    ({ label, value: null, source, asOf: null, unavailableBecause: why });

  const repoRes = await getJson(`${GH_API}/repos/${repo}`, headers);
  const rateRemaining = repoRes.ok ? repoRes.rateRemaining ?? null : null;

  let stars = unavailable('GitHub stars', `api.github.com/repos/${repo}`, 'repository not readable');
  let forks = unavailable('Forks', `api.github.com/repos/${repo}`, 'repository not readable');
  let watchers = unavailable('Watchers', `api.github.com/repos/${repo}`, 'repository not readable');
  let openIssues = unavailable('Open issues', `api.github.com/repos/${repo}`, 'repository not readable');

  if (repoRes.ok) {
    const b = repoRes.body as { stargazers_count: number; forks_count: number; subscribers_count: number; open_issues_count: number };
    const src = `api.github.com/repos/${repo}`;
    stars = { label: 'GitHub stars', value: b.stargazers_count, source: src, asOf: now };
    forks = { label: 'Forks', value: b.forks_count, source: src, asOf: now };
    watchers = { label: 'Watchers', value: b.subscribers_count ?? null, source: src, asOf: now };
    openIssues = {
      label: 'Open issues', value: b.open_issues_count, source: src, asOf: now,
      caveat: 'GitHub counts open pull requests in this figure.',
    };
  }

  // Traffic requires WRITE access. Without a token it 403s, which is reported plainly rather
  // than shown as zero traffic.
  const trafficNote = 'GitHub reports the last 14 days only, and the traffic endpoints require a '
    + 'token with write access to the repository.';
  const series: Record<'clones' | 'views', DayPoint[]> = { clones: [], views: [] };
  const mk = async (kind: 'clones' | 'views'): Promise<[Reading, Reading]> => {
    const src = `api.github.com/repos/${repo}/traffic/${kind}`;
    const r = await getJson(`${GH_API}/repos/${repo}/traffic/${kind}`, headers);
    const totalLabel = kind === 'clones' ? 'Clones (14d)' : 'Page views (14d)';
    const uniqueLabel = kind === 'clones' ? 'Unique cloners (14d)' : 'Unique visitors (14d)';
    if (!r.ok) {
      const why = r.status === 403 || r.status === 401
        ? 'needs a GitHub token with write access to this repository (see ops/DASHBOARD.md)'
        : r.reason;
      return [unavailable(totalLabel, src, why), unavailable(uniqueLabel, src, why)];
    }
    const b = r.body as { count: number; uniques: number; clones?: DayPointRaw[]; views?: DayPointRaw[] };
    const raw = (kind === 'clones' ? b.clones : b.views) ?? [];
    series[kind] = raw.map((d) => ({ day: String(d.timestamp).slice(0, 10), count: d.count, uniques: d.uniques }));
    return [
      { label: totalLabel, value: b.count, source: src, asOf: now, caveat: trafficNote },
      { label: uniqueLabel, value: b.uniques, source: src, asOf: now, caveat: trafficNote },
    ];
  };

  const [[clones14d, uniqueCloners14d], [views14d, uniqueVisitors14d]] =
    await Promise.all([mk('clones'), mk('views')]);

  let referrers: { name: string; count: number; uniques: number }[] = [];
  const refRes = await getJson(`${GH_API}/repos/${repo}/traffic/popular/referrers`, headers);
  if (refRes.ok && Array.isArray(refRes.body)) {
    referrers = (refRes.body as { referrer: string; count: number; uniques: number }[])
      .map((r) => ({ name: r.referrer, count: r.count, uniques: r.uniques }));
  }

  return {
    stars, forks, watchers, openIssues, clones14d, uniqueCloners14d, views14d, uniqueVisitors14d,
    referrers, rateRemaining,
    cloneSeries: series.clones, viewSeries: series.views,
    plausibility: clonePlausibility(uniqueCloners14d.value, uniqueVisitors14d.value),
  };
}

/**
 * THE NORTH STAR: installs that produced a first catch.
 *
 * This is the metric the whole product is judged by — spec §3B says the activation metric is
 * "usewarden caught something in a real session", not "installed". It cannot be computed from any
 * public source, because it is a property of what happened on someone's machine.
 *
 * It lights up automatically when the aggregator exists: the payload already carries
 * `checklist` (which includes `first_catch`) and `counts.live_catches`, so the moment
 * `/v1/stats` is reachable this returns real figures. Until then it reports honestly that the
 * number does not exist yet — never a zero, and never an estimate.
 */
export interface ImpactReadings {
  available: boolean;
  reason?: string;
  installsWithFirstCatch: Reading;
  interventions: Reading;
  correctionRate: Reading;
  source: string;
}

export async function impactReadings(statsUrl: string | undefined): Promise<ImpactReadings> {
  const source = statsUrl ? `${statsUrl}` : 'the aggregator (not deployed)';
  const pending = (label: string, why: string): Reading =>
    ({ label, value: null, source, asOf: null, unavailableBecause: why });

  if (!statsUrl) {
    const why = 'the telemetry aggregator is built but NOT deployed, and telemetry is off by '
      + 'default with no endpoint shipped. This lights up automatically once it exists.';
    return {
      available: false, reason: why, source,
      installsWithFirstCatch: pending('Installs that produced a first catch', why),
      interventions: pending('Interventions (blocks + drift warnings)', why),
      correctionRate: pending('Correction rate', why),
    };
  }

  const r = await getJson(statsUrl);
  if (!r.ok) {
    return {
      available: false, reason: r.reason, source,
      installsWithFirstCatch: pending('Installs that produced a first catch', r.reason),
      interventions: pending('Interventions (blocks + drift warnings)', r.reason),
      correctionRate: pending('Correction rate', r.reason),
    };
  }

  const now = new Date().toISOString();
  const b = r.body as {
    checklist?: { step: string; submissions: number }[];
    buckets?: { submissions: number; actions_blocked: number; drift_caught: number; live_catches: number }[];
  };
  const firstCatch = (b.checklist ?? []).filter((c) => c.step === 'first_catch')
    .reduce((n, c) => n + Number(c.submissions), 0);
  const blocked = (b.buckets ?? []).reduce((n, x) => n + Number(x.actions_blocked), 0);
  const drift = (b.buckets ?? []).reduce((n, x) => n + Number(x.drift_caught), 0);
  const submissions = (b.buckets ?? []).reduce((n, x) => n + Number(x.submissions), 0);

  return {
    available: true, source,
    installsWithFirstCatch: {
      label: 'Installs that produced a first catch', value: firstCatch, source, asOf: now,
      caveat: 'Counted from opt-in telemetry only, and k-anonymity suppresses thin buckets, so '
        + 'this is a FLOOR — the true number is higher and unknowable.',
    },
    interventions: {
      label: 'Interventions (blocks + drift warnings)', value: blocked + drift, source, asOf: now,
      caveat: `${blocked} blocks and ${drift} drift warnings. Reported as a composite AND its `
        + 'parts, because docs/METRICS.md forbids presenting a composite as its strongest component.',
    },
    correctionRate: {
      label: 'Correction rate', value: submissions > 0 ? Math.round((firstCatch / submissions) * 100) : null,
      source, asOf: now,
      caveat: 'Share of reporting installs that reached a first catch. Opt-in telemetry only.',
    },
  };
}
