import * as http from 'node:http';
import { execFileSync } from 'node:child_process';
import { githubReadings, impactReadings, npmDownloads, type DayPoint, type GitHubReadings, type ImpactReadings, type Reading } from './sources.js';
import { buildFunnel, formatGrowth, weekOverWeek, type FunnelStage, type Growth } from './growth.js';
import { wallFromStore, type WallEntry } from './incidents.js';
import { Store } from '../../../src/store.js';

/**
 * `npm run dashboard:web` — the visual dashboard, on 127.0.0.1, for someone non-technical.
 *
 * DESIGN DECISIONS, and why each one:
 *
 *  - **One number dominates.** Installs that produced a first catch is a HERO NUMBER, not a
 *    chart: it is a single headline value, and the form heuristic says a lone magnitude is a stat
 *    tile. Everything else is a small tile at a third the size. A dashboard where five numbers
 *    are the same size tells the reader nothing about which one matters.
 *  - **Sparklines, one series each, no legend.** A single series needs no legend — the title
 *    names it. 2px line, ≥8px end marker, recessive axis. Trend where the data allows it: GitHub
 *    gives 14 days of daily traffic, so those get a line; the hero has no history yet and says so
 *    rather than drawing a flat line at zero, which would read as "nothing is happening".
 *  - **Unavailable stays unavailable.** A missing figure renders as an em-dash with its reason in
 *    small text. There is no zero, no placeholder, no "—" that could be mistaken for a measured
 *    value, and no cached previous reading.
 *  - **Self-contained.** No CDN, no webfont, no external image. A strict CSP is served as a real
 *    header, and the only script is the reload timer.
 *  - **Palette validated, not eyeballed.** #3b6fd0 series / #0ca30c good, run through the
 *    validator: lightness band, chroma floor, CVD separation, normal-vision floor and contrast
 *    all PASS on both surfaces.
 */

const REPO = process.env['USEWARDEN_DASHBOARD_REPO'] ?? 'djayamah/usewarden';
const PKG = process.env['USEWARDEN_DASHBOARD_PKG'] ?? 'usewarden';
const STATS_URL = process.env['USEWARDEN_AGGREGATOR_STATS_URL'];

const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; "
  + "img-src 'self' data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

function ghToken(): string | undefined {
  if (process.env['GITHUB_TOKEN']) return process.env['GITHUB_TOKEN'];
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch { return undefined; }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

const fmt = (n: number): string => n.toLocaleString('en-US');

function ago(iso: string | null): string {
  if (!iso) return 'unknown';
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (mins < 2) return 'just now';
  if (mins < 90) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 36 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

/**
 * Sparkline. One series, 2px, with an 8px end marker anchored to the last point.
 * Returns '' when there is nothing to draw — a flat line at zero is a lie about the data.
 */
function sparkline(points: number[], w = 210, h = 40): string {
  if (points.length < 2 || points.every((p) => p === 0)) return '';
  const max = Math.max(...points);
  const min = Math.min(...points);
  const span = max - min || 1;
  const step = w / (points.length - 1);
  const y = (v: number): number => h - 4 - ((v - min) / span) * (h - 10);
  const d = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const lastX = (w).toFixed(1);
  const lastY = y(points[points.length - 1]!).toFixed(1);
  return `<svg class="spark" viewBox="0 0 ${w + 6} ${h}" width="${w + 6}" height="${h}" role="img" aria-label="trend, last ${points.length} days">
    <path d="${d}" fill="none" stroke="var(--series)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${lastX}" cy="${lastY}" r="4" fill="var(--series)" stroke="var(--surface)" stroke-width="2"/>
  </svg>`;
}

/**
 * `growth` belongs INSIDE the tile it describes. Rendered after the grid it became two unattached
 * sentences under eight tiles, and "35 this week, up from none last week" beneath a row of numbers
 * does not say which number it is about - a rate no one can attach to a metric is not a rate.
 */
function tile(r: Reading, spark = '', growth = ''): string {
  if (r.value === null) {
    return `<div class="tile na">
      <div class="v na">&mdash;</div>
      <div class="k">${esc(r.label)}</div>
      <div class="why">${esc(r.unavailableBecause ?? 'unavailable')}</div>
    </div>`;
  }
  return `<div class="tile">
    <div class="v">${fmt(r.value)}</div>
    <div class="k">${esc(r.label)}</div>
    ${growth}
    ${spark}
    <div class="src">${esc(r.source)} &middot; ${esc(ago(r.asOf))}</div>
  </div>`;
}

/** A growth line, or the reason there isn't one. Never a flat line standing in for no data. */
/**
 * `neutral` strips the good/bad colour from a rate whose underlying figure the page has already
 * said not to believe. A green upward arrow on the clone count - which the caution box directly
 * below calls automated traffic - is the page cheering for a number it just discounted, and green
 * is read before any words are. Growth on an untrusted metric is still shown, in plain ink.
 */
function growthLine(g: Growth, neutral = false): string {
  const cls = neutral ? 'neutral' : g.available ? g.direction : 'none';
  return g.available
    ? `<div class="growth ${cls}">${g.direction === 'up' ? '▲' : g.direction === 'down' ? '▼' : '—'} ${esc(formatGrowth(g))}</div>`
    : `<div class="growth none">no trend yet — ${esc(g.reason)}</div>`;
}

function wallHtml(entries: WallEntry[]): string {
  if (entries.length === 0) {
    return '<p class="muted">No catches recorded yet on this machine.</p>';
  }
  return entries.map((e) => `<div class="inc ${e.action}">
    <div class="inc-what">${esc(e.what)}</div>
    <div class="inc-why">${esc(e.why)} &middot; <b>${e.action}</b> &middot; ${esc(ago(e.at))}</div>
  </div>`).join('');
}

function funnelHtml(stages: FunnelStage[]): string {
  const known = stages.filter((s) => s.value !== null);
  const max = known.length > 0 ? Math.max(...known.map((s) => s.value!)) : 0;

  // When every missing stage is missing for the SAME reason - which is today's case, because they
  // all wait on the aggregator - the reason is said once above the funnel instead of five times
  // under five bars. Repeating one long sentence five times is not five times as honest; it is
  // noise, and noise is what gets skipped.
  const reasons = new Set(stages.filter((s) => s.value === null).map((s) => s.unavailableBecause ?? 'unavailable'));
  const shared = reasons.size === 1 ? [...reasons][0]! : null;
  const head = shared ? `<div class="fn-why fn-why-all">Every stage below: ${esc(shared)}</div>` : '';

  return head + stages.map((s) => {
    if (s.value === null) {
      const why = shared ? '' : `\n        <div class="fn-why">${esc(s.unavailableBecause ?? 'unavailable')}</div>`;
      return `<div class="fn"><div class="fn-l">${esc(s.label)}</div>
        <div class="fn-bar"><div class="fn-fill na"></div></div>
        <div class="fn-v na">&mdash;</div></div>${why}`;
    }
    const pct = max > 0 ? (s.value / max) * 100 : 0;
    const drop = s.dropFromPrevPct !== null && s.dropFromPrevPct > 0
      ? `<span class="fn-drop">&minus;${s.dropFromPrevPct.toFixed(0)}% from the step above</span>` : '';
    return `<div class="fn"><div class="fn-l">${esc(s.label)}</div>
      <div class="fn-bar"><div class="fn-fill" style="width:${pct.toFixed(1)}%"></div></div>
      <div class="fn-v">${fmt(s.value)}</div></div>${drop ? `<div class="fn-why">${drop}</div>` : ''}`;
  }).join('');
}

export function renderPage(d: {
  repo: string; pkg: string; generatedAt: string;
  impact: ImpactReadings; github: GitHubReadings; npm: Reading[];
  wall: WallEntry[]; funnel: FunnelStage[];
  nsGrowth: Growth; cloneGrowth: Growth; viewGrowth: Growth;
  /** `?mode=present` pins the mode server-side, so the presentation view is a shareable link. */
  mode?: 'founder' | 'present';
}): string {
  const ns = d.impact.installsWithFirstCatch;
  const plaus = d.github.plausibility;
  const cloneSpark = sparkline(d.github.cloneSeries.map((p: DayPoint) => p.uniques));
  const viewSpark = sparkline(d.github.viewSeries.map((p: DayPoint) => p.uniques));

  // A 116px em-dash rendered as a grey bar that read like a redaction. An unavailable hero needs
  // to look like an honest "not yet", not like something withheld.
  const hero = ns.value === null
    ? `<div class="hero-pending">Not measurable yet</div>
       <div class="hero-why">${esc(ns.unavailableBecause ?? 'not measurable yet')}</div>`
    : `<div class="hero-n">${fmt(ns.value)}</div>
       <div class="hero-src">${esc(ns.source)} &middot; ${esc(ago(ns.asOf))}</div>
       ${ns.caveat ? `<div class="hero-why">${esc(ns.caveat)}</div>` : ''}`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>usewarden — dashboard</title>
<style>
:root{
  --surface:#fcfcfb; --ink:#14171a; --ink-2:#5b6672; --ink-3:#8a929b;
  --line:#e6e8ea; --card:#ffffff; --series:#3b6fd0; --good:#0ca30c; --warn:#8a6100;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
@media (prefers-color-scheme:dark){
  :root{--surface:#1a1a19;--ink:#e6edf3;--ink-2:#9aa4ae;--ink-3:#767f88;
        --line:#2b2f34;--card:#212124;--series:#7aa2f7;--good:#56d364;--warn:#e3b341;}
}
*{box-sizing:border-box}
body{margin:0;background:var(--surface);color:var(--ink);font:16px/1.55 var(--sans)}
main{max-width:960px;margin:0 auto;padding:40px 20px 80px}
h1{font-size:15px;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-2);
   font-weight:600;margin:0 0 6px}
.sub{color:var(--ink-3);font-size:13px;margin:0 0 32px}

/* HERO — the one number that matters. Everything else is a third of this. */
.hero{background:var(--card);border:1px solid var(--line);border-radius:14px;
      padding:34px 32px;margin:0 0 14px}
.hero-label{font-size:13px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-2);
            font-weight:600;margin:0 0 10px}
.hero-n{font:700 clamp(64px,13vw,116px)/1 var(--sans);letter-spacing:-.03em;color:var(--good)}
.hero-pending{font:600 clamp(26px,5vw,42px)/1.15 var(--sans);color:var(--ink-3);
              letter-spacing:-.01em;padding:14px 0 2px}
.hero-src{font-family:var(--mono);font-size:12px;color:var(--ink-3);margin-top:12px}
.hero-why{font-size:13px;color:var(--ink-2);margin-top:12px;max-width:62ch}
.hero-note{font-size:13.5px;color:var(--ink-2);margin:0 0 30px;max-width:70ch}

h2{font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-2);
   font-weight:600;margin:34px 0 12px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px}
.tile .v{font:700 30px/1.1 var(--sans);letter-spacing:-.01em}
.tile .v.na{color:var(--ink-3);font-weight:400}
.tile .k{font-size:12px;color:var(--ink-2);margin-top:6px}
.tile .src{font-family:var(--mono);font-size:10.5px;color:var(--ink-3);margin-top:10px;word-break:break-all}
.tile .why{font-size:12px;color:var(--ink-3);margin-top:8px}
.spark{display:block;margin:10px 0 2px;overflow:visible}

.caution{border:1px solid var(--line);border-left:3px solid var(--warn);border-radius:8px;
         background:var(--card);padding:14px 16px;margin:12px 0 0;font-size:13.5px;color:var(--ink-2)}
.caution b{color:var(--ink)}
table{border-collapse:collapse;width:100%;font-size:13.5px;margin-top:4px}
td,th{text-align:left;padding:7px 9px;border-bottom:1px solid var(--line)}
th{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--ink-2);font-weight:600}
footer{margin-top:44px;padding-top:16px;border-top:1px solid var(--line);
       color:var(--ink-3);font-size:12px}
.muted{color:var(--ink-3);font-size:13px;margin:0 0 14px;max-width:72ch}

.topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.modes{display:flex;gap:0;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.mode-btn{appearance:none;border:0;background:var(--card);color:var(--ink-2);font:600 12px/1 var(--sans);
          padding:9px 14px;cursor:pointer;letter-spacing:.03em}
.mode-btn[aria-pressed="true"]{background:var(--series);color:#fff}

/* Growth. Direction is never carried by colour alone - the arrow and the words say it too. */
.growth{font-size:13px;margin-top:6px;color:var(--ink-2)}
.tile .growth{font-size:12px;margin:4px 0 0 0;line-height:1.35}
.growth.up{color:var(--good)}
.growth.down{color:var(--warn)}
.growth.none{color:var(--ink-3);font-style:normal}
.growth.neutral{color:var(--ink-2)}

/* Incident wall */
.inc{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--warn);
     border-radius:8px;padding:12px 15px;margin:0 0 9px}
.inc.blocked{border-left-color:var(--series)}
.inc-what{font-size:15px;font-weight:600;line-height:1.35}
.inc-why{font-size:12.5px;color:var(--ink-2);margin-top:5px}

/* Funnel */
.fn{display:grid;grid-template-columns:minmax(120px,190px) 1fr 64px;gap:12px;align-items:center;
    margin:0 0 6px}
.fn-l{font-size:13.5px;color:var(--ink-2)}
.fn-bar{background:var(--line);border-radius:5px;height:22px;overflow:hidden}
.fn-fill{background:var(--series);height:100%;border-radius:5px 0 0 5px;min-width:3px}
.fn-fill.na{background:transparent}
.fn-v{font:700 16px/1 var(--sans);text-align:right}
.fn-v.na{color:var(--ink-3);font-weight:400}
.fn-why{font-size:12px;color:var(--ink-3);margin:0 0 12px 0;padding-left:2px}
.fn-why-all{margin:0 0 14px 0}
.fn-drop{color:var(--warn)}

/* PRESENTATION MODE. Not a filter over the founder view - a different document. It shows the
   North Star, its growth, the wall and the funnel, and hides every diagnostic, caveat box and
   zero. Anything that needs explaining does not belong in front of an audience. */
body[data-mode="present"] .founder-only{display:none}
body[data-mode="present"] .caution{display:none}
/* Nothing at zero and nothing that needs explaining. An unavailable tile is both: it shows a
   dash and then a paragraph about why. In front of an audience that is not candour, it is
   clutter that invites the wrong question. The founder view keeps every one of them. */
body[data-mode="present"] .tile.na{display:none}
body[data-mode="present"] .hero-why{display:none}
body[data-mode="present"] .fn-why{display:none}
body[data-mode="present"] .growth.none{display:none}
/* A section whose tiles have all been hidden would leave an orphan heading. */
body[data-mode="present"] .section-empty{display:none}
body[data-mode="present"] .hero{padding:48px 40px}
body[data-mode="present"] main{padding-top:28px}
@media (max-width:760px){ .fn{grid-template-columns:1fr 1fr 54px} }
</style></head><body${d.mode ? ` data-mode="${d.mode}"` : ''}><main>

<div class="topbar">
  <h1>usewarden</h1>
  <div class="modes">
    <button class="mode-btn" data-mode="present" onclick="setMode('present')">Presentation</button>
    <button class="mode-btn" data-mode="founder" onclick="setMode('founder')">Founder</button>
  </div>
</div>
<p class="sub founder-only">Updated ${esc(ago(d.generatedAt))} &middot; refreshes itself every 60 seconds &middot; every number below names its source</p>

<div class="hero">
  <div class="hero-label">Installs that produced a first catch</div>
  ${hero}
  ${growthLine(d.nsGrowth)}
</div>
<p class="hero-note"><b>This is the only number that really matters.</b> Not downloads, not stars —
people who installed usewarden and whose agent then actually did something it stopped. Everything
below is secondary and is shown smaller on purpose.</p>

<h2 class="${d.impact.available ? '' : 'section-empty'}">Impact</h2>
<div class="grid ${d.impact.available ? '' : 'section-empty'}">
  ${tile(d.impact.interventions)}
  ${tile(d.impact.correctionRate)}
</div>

<h2>What it has stopped</h2>
<p class="muted">Real catches, described without any file path, project name or command &mdash; on this
machine or anyone else's.</p>
${wallHtml(d.wall)}

<h2 class="${d.funnel.some((f) => f.value !== null) ? '' : 'section-empty'}">From install to habit</h2>
<div class="${d.funnel.some((f) => f.value !== null) ? '' : 'section-empty'}">
${funnelHtml(d.funnel)}
</div>

<h2 class="founder-only">Reach &mdash; traffic, not people</h2>
<div class="founder-only">
<div class="grid">
  ${d.npm.map((r) => tile(r)).join('')}
  ${tile(d.github.stars)}
  ${tile(d.github.forks)}
  ${tile(d.github.uniqueVisitors14d, viewSpark, growthLine(d.viewGrowth))}
  ${tile(d.github.uniqueCloners14d, cloneSpark, growthLine(d.cloneGrowth, plaus.verdict === 'likely-automated'))}
</div>
${plaus.verdict === 'likely-automated' ? `<div class="caution"><b>Treat the clone figures as automated traffic.</b> ${esc(plaus.note)}</div>` : ''}
${plaus.verdict === 'human-plausible' ? `<div class="caution">${esc(plaus.note)}</div>` : ''}
</div>

${d.github.referrers.length > 0 ? `<h2 class="founder-only">Where people came from (14 days)</h2>
<div class="founder-only">
<table><thead><tr><th>Source</th><th>Unique</th><th>Total</th></tr></thead><tbody>
${d.github.referrers.slice(0, 6).map((r) => `<tr><td>${esc(r.name)}</td><td>${fmt(r.uniques)}</td><td>${fmt(r.count)}</td></tr>`).join('')}
</tbody></table></div>` : ''}

<footer class="founder-only">
Generated ${esc(d.generatedAt)}. Nothing here is cached, estimated, or carried over from a previous
load. A figure that could not be fetched shows &mdash; with the reason, never a zero.
${d.github.rateRemaining ? `GitHub API calls left this hour: ${esc(d.github.rateRemaining)}.` : ''}
</footer>
</main>
<script>
var PINNED = ${JSON.stringify(d.mode ?? null)};
function setMode(m){
  document.body.setAttribute('data-mode', m);
  try { localStorage.setItem('uw-mode', m); } catch (e) {}
  document.querySelectorAll('.mode-btn').forEach(function(b){
    b.setAttribute('aria-pressed', String(b.getAttribute('data-mode') === m));
  });
}
(function(){
  if (PINNED) { setMode(PINNED); return; }
  var saved = 'founder';
  try { saved = localStorage.getItem('uw-mode') || 'founder'; } catch (e) {}
  setMode(saved);
})();
setTimeout(function(){ location.reload(); }, 60000);
</script>
</body></html>`;
}

export async function serve(port = 7777): Promise<void> {
  const token = ghToken();
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    const qs = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
    const mode = qs.get('mode') === 'present' ? 'present' as const
      : qs.get('mode') === 'founder' ? 'founder' as const : undefined;
    const [impact, github, day, week, month] = await Promise.all([
      impactReadings(STATS_URL), githubReadings(REPO, token),
      npmDownloads(PKG, 'last-day'), npmDownloads(PKG, 'last-week'), npmDownloads(PKG, 'last-month'),
    ]);

    // The incident wall comes from the LOCAL store today and from the aggregator once it exists.
    // Opened read-only-in-practice and closed immediately; the dashboard never writes.
    let wall: WallEntry[] = [];
    try { const st = new Store(); wall = wallFromStore(st, 8); st.close(); } catch { wall = []; }

    const funnel = buildFunnel({
      installs: null, sessionsProtected: null, firstCatch: impact.installsWithFirstCatch.value,
      activeWeek2: null, activeWeek4: null,
      source: impact.source,
      ...(impact.reason ? { unavailableReason: impact.reason } : {}),
    });

    const html = renderPage({
      repo: REPO, pkg: PKG, generatedAt: new Date().toISOString(),
      impact, github, npm: [day, week, month], wall, funnel,
      ...(mode ? { mode } : {}),
      nsGrowth: { available: false, reason: 'the North Star has no history until the aggregator is deployed' },
      cloneGrowth: weekOverWeek(github.cloneSeries),
      viewGrowth: weekOverWeek(github.viewSeries),
    });
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    });
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  process.stdout.write(`\n  usewarden dashboard\n  http://127.0.0.1:${port}\n\n  Open that in your browser. Ctrl-C to stop.\n\n`);
}

if (process.argv[1]?.endsWith('web.js')) {
  const p = Number(process.argv[2] ?? process.env['PORT'] ?? 7777);
  serve(Number.isFinite(p) ? p : 7777).catch((e: Error) => {
    process.stderr.write(`dashboard:web: ${e.message}\n`); process.exitCode = 1;
  });
}
