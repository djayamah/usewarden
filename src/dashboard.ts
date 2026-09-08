import { displayPath } from './util.js';
import * as http from 'node:http';
import { randomBytes } from 'node:crypto';
import { Store } from './store.js';
import { buildStatus } from './status.js';
import { head, dim, ok } from './term.js';
import { fmtTokenBand, fmtUsdBand, type Metrics } from './metrics.js';
import { buildValueReport, figureReason, SEVERITY_ORDER, type ValueReport } from './value.js';
import { loadPolicy } from './policy/load.js';
import { defaultLabelsFile } from './paths.js';

/**
 * Local read-only dashboard.
 *
 * Security posture (docs/THREAT-MODEL.md T-13), all asserted in tests/dashboard.test.ts:
 *   - binds 127.0.0.1 ONLY, never 0.0.0.0;
 *   - a random per-session token is required on every request; without it, 404;
 *   - GET only; there is no route that mutates anything;
 *   - strict CSP, and the page embeds all CSS/JS inline - no CDN, no external asset, no font;
 *   - no CORS header, so a page on another origin cannot read it even with the token.
 */

export interface DashboardHandle {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

const CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "img-src 'self' data:",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

export async function startDashboard(port = 0, store?: Store): Promise<DashboardHandle> {
  const owned = store === undefined;
  const s = store ?? new Store();
  const token = randomBytes(24).toString('base64url');

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const deny = (code: number, body: string) => {
      res.writeHead(code, {
        'content-type': 'text/plain; charset=utf-8',
        'content-security-policy': CSP,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-store',
      });
      res.end(body);
    };

    if (req.method !== 'GET') return deny(405, 'read-only');
    if (url.searchParams.get('t') !== token) return deny(404, 'not found');

    const payload = snapshot(s);
    if (url.pathname === '/api') {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-security-policy': CSP,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify(payload));
      return;
    }
    if (url.pathname !== '/') return deny(404, 'not found');

    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    });
    res.end(renderHtml(payload, token, url.searchParams.get('theme')));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;

  return {
    url: `http://127.0.0.1:${actualPort}/?t=${token}`,
    port: actualPort,
    token,
    close: () => new Promise<void>((resolve) => {
      server.close(() => { if (owned) s.close(); resolve(); });
      server.closeAllConnections?.();
    }),
  };
}

export interface Snapshot {
  overall: string;
  agents: { label: string; state: string; configPath: string }[];
  counters: Record<string, number>;
  /** Derived, per-origin figures. Everything the page displays comes from here. */
  metrics: Metrics;
  liveCatches: number;
  totalCatches: number;
  judgeUsd: number;
  judgeUnmetered: number;
  checklist: { label: string; done: boolean }[];
  contextWarnPct: number;
  /**
   * The value figures. FIRST in the type and first on the page, because every counter below it
   * goes UP when usewarden is WRONG - which is how a dashboard reports 59 useful events during a
   * period in which 42 of 92 blocks were false positives.
   */
  value: ValueReport;
  incidents: {
    ts: number; agent: string; action: string; title: string; attempted: string;
    reason: string; rule: string; live: number; origin: string; layer: number; severity: string;
  }[];
  generatedAt: number;
}

export function snapshot(store: Store): Snapshot {
  const r = buildStatus(store, process.cwd());
  return {
    overall: r.overall,
    agents: r.agents.map((a) => ({ label: a.label, state: a.state, configPath: displayPath(a.configPath) })),
    counters: r.counters,
    metrics: r.metrics,
    liveCatches: r.liveCatches,
    totalCatches: r.totalCatches,
    judgeUsd: r.judge.usd,
    judgeUnmetered: r.judge.unmetered,
    checklist: r.checklist.map((c) => ({ label: c.label, done: c.done })),
    contextWarnPct: 60,
    value: buildValueReport({
      store,
      policy: loadPolicy(process.cwd()).policy,
      labelsFile: defaultLabelsFile(),
    }),
    incidents: store.recentIncidents(50).map((i) => ({
      ts: i.ts, agent: i.agent, action: i.action, title: i.title,
      attempted: displayPath(i.attempted), reason: displayPath(i.reason),
      rule: i.rule, live: i.live, origin: i.origin, layer: i.layer, severity: i.severity,
    })),
    generatedAt: Date.now(),
  };
}

/**
 * The value block: precision first, coverage beside it, then what was caught and what was wrong.
 *
 * EVERY FIGURE HERE CAN RENDER AS "unavailable", AND THAT IS THE POINT. Most machines have no
 * labelled set, so precision on them is genuinely unknown - and a dashboard that renders unknown
 * as 0% or as 100% is lying in one direction or the other. The reason is printed beside the word,
 * because "unavailable" with no explanation reads as broken.
 */
function valueSection(v: ValueReport): string {
  const note = (reason: string): string =>
    `<p class="unavail"><b>unavailable</b> &mdash; ${esc(reason)}</p>`;

  const headline = v.precision.available && v.coverage.available
    ? `<div class="grid headline">
         <div class="stat big"><b>${v.precision.value.pct.toFixed(1)}%</b>
           <span>precision &mdash; of ${v.precision.value.denominator} blocks that fire today,
           ${v.precision.value.truePositives} are ones a developer would want</span></div>
         <div class="stat big"><b>${v.coverage.value.pct.toFixed(1)}%</b>
           <span>coverage &mdash; ${v.coverage.value.caught} of the ${v.coverage.value.total} real
           catches in the corpus still fire</span></div>
       </div>
       ${v.precision.value.indeterminate > 0
      ? `<p class="unavail">${v.precision.value.indeterminate} labelled incident(s) could not be
           re-evaluated and are counted against the total, not as passes.</p>` : ''}`
    : `${note(figureReason(v.precision) || figureReason(v.coverage))}`;

  const provenance = v.labelSet.available
    ? `<p class="prov">Labelled set: <b>${v.labelSet.value.labelled}</b> incidents, labelled
       <b>${esc(v.labelSet.value.labelledAt)}</b>, frozen at
       <code>${esc(v.labelSet.value.hash.slice(0, 16))}…</code>. Precision and coverage are meaningless
       without this line, so it is printed with them and never separately.</p>`
    : '';

  const sev = v.truePositivesBySeverity.available
    ? `<div class="tablewrap"><table><thead><tr><th>severity</th><th>caught</th><th>what it means</th></tr></thead><tbody>
       ${SEVERITY_ORDER.map((name) => {
      const row = v.truePositivesBySeverity.available
        ? v.truePositivesBySeverity.value.find((r) => r.severity === name) : undefined;
      const meaning = name === 'critical'
        ? 'a credential reached the model, or the guard itself was being disabled'
        : name === 'high'
          ? 'the agent left the boundary it was given, or destroyed something outside it'
          : 'recoverable, or advisory';
      return `<tr><td class="sev-${name}">${name}</td><td><b>${row?.count ?? 0}</b></td>
                <td style="color:var(--dim)">${meaning}</td></tr>`;
    }).join('')}
       </tbody></table></div>`
    : note(figureReason(v.truePositivesBySeverity));

  const fp = v.falsePositivesByClass.available
    ? (v.falsePositivesByClass.value.length === 0
      ? '<p class="prov">No false positives in the labelled set.</p>'
      : `<div class="tablewrap"><table><thead><tr><th>class</th><th>when recorded</th><th>still firing</th></tr></thead><tbody>
         ${v.falsePositivesByClass.value.map((r) => `<tr><td>${esc(r.name)}</td>
           <td style="color:var(--dim)">${r.then}</td>
           <td class="${r.now === 0 ? 'fixed' : 'stillbad'}"><b>${r.now}</b></td></tr>`).join('')}
         </tbody></table></div>
         <p class="prov">The right-hand column is the number that has to fall. It is the count of
         blocks that were wrong and would still be wrong today.</p>`)
    : note(figureReason(v.falsePositivesByClass));

  return `
<h2 style="font-size:13px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em">Value &mdash; was it right?</h2>
${headline}
${provenance}
<h2 style="font-size:13px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em">What it caught, by severity</h2>
${sev}
<h2 style="font-size:13px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em">What it got wrong, by class</h2>
${fp}
<p class="prov">${v.activity.excludedDemo + v.activity.excludedFixture} demo and fixture incident(s)
exist in this database and cannot reach any figure above &mdash; not filtered out at the end, but
never admitted: the value figures read only <code>origin='live'</code>.</p>
`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/**
 * `theme` forces light or dark instead of following the viewer's OS preference. It exists so the
 * verification screenshots can capture BOTH palettes deterministically: a headless browser
 * ignores --force-dark-mode for prefers-color-scheme, so without this the "dark" screenshot was
 * byte-identical to the light one and proved nothing.
 */
export function renderHtml(d: Snapshot, token: string, theme?: string | null): string {
  const stateClass = d.overall === 'PROTECTED' ? 'good' : 'bad';
  const themeAttr = theme === 'dark' || theme === 'light' ? ` data-theme="${theme}"` : '';
  const cards = d.incidents.length === 0
    ? `<p class="empty">No incidents yet. Run <code>usewarden demo</code> to see what one looks like.</p>`
    : d.incidents.map((i) => `
      <article class="card ${i.severity === 'block' ? 'block' : 'warn'}">
        <header>
          <span class="badge">${esc(i.action.toUpperCase())}</span>
          <h3>${esc(i.title)}</h3>
          <span class="when">${esc(new Date(i.ts).toISOString().replace('T', ' ').slice(0, 19))}Z</span>
        </header>
        <dl>
          <dt>agent</dt><dd>${esc(i.agent)} ${i.origin === 'live' ? '<span class="live">live session</span>' : `<span class="fixture">${esc(i.origin)}</span>`}</dd>
          <dt>attempt</dt><dd><code>${esc(i.attempted)}</code></dd>
          <dt>why</dt><dd>${esc(i.reason)}</dd>
          <dt>rule</dt><dd><code>${esc(i.rule)}</code> <span class="layer">layer ${i.layer}</span></dd>
        </dl>
      </article>`).join('');

  return `<!doctype html>
<html lang="en"${themeAttr}><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>usewarden</title>
<style>
:root{--bg:#0d1117;--fg:#e6edf3;--dim:#8b949e;--line:#30363d;--good:#3fb950;--bad:#f85149;--warn:#d29922;--card:#161b22}
@media(prefers-color-scheme:light){html:not([data-theme=dark]){--bg:#fff;--fg:#1f2328;--dim:#656d76;--line:#d0d7de;--card:#f6f8fa}}
html[data-theme=light]{--bg:#fff;--fg:#1f2328;--dim:#656d76;--line:#d0d7de;--card:#f6f8fa}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}
main{max-width:900px;margin:0 auto;padding:32px 20px 80px}
h1{font-size:20px;margin:0 0 4px;letter-spacing:.04em}
.state{display:inline-block;padding:3px 10px;border-radius:4px;font-weight:700;letter-spacing:.08em}
.state.good{background:var(--good);color:#06170b}.state.bad{background:var(--bad);color:#2b0705}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:12px;margin:24px 0}
.stat{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:14px}
.stat b{display:block;font-size:26px;line-height:1.1}
.stat span{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.08em}
ul.check{list-style:none;padding:0;margin:0 0 24px}
ul.check li{padding:3px 0;color:var(--dim)}ul.check li.done{color:var(--fg)}
/* Wide content scrolls inside its own container; the page body never scrolls sideways. */
.tablewrap{overflow-x:auto;margin-bottom:24px}
table{width:100%;border-collapse:collapse;min-width:520px}
td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);font-size:13px}
th{color:var(--dim);font-weight:400;text-transform:uppercase;font-size:11px;letter-spacing:.08em}
.card{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--warn);border-radius:6px;padding:14px 16px;margin-bottom:14px;overflow-x:auto}
.card.block{border-left-color:var(--bad)}
.card header{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.card h3{margin:0;font-size:14px;flex:1}
.badge{background:var(--bad);color:#2b0705;padding:1px 7px;border-radius:3px;font-size:11px;font-weight:700}
.card.warn .badge{background:var(--warn);color:#231a02}
.when{color:var(--dim);font-size:11px}
dl{display:grid;grid-template-columns:70px 1fr;gap:2px 10px;margin:10px 0 0}
dt{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
dd{margin:0;word-break:break-word}
.live{color:var(--good)}.fixture{color:var(--dim)}.layer{color:var(--dim);font-size:11px}
.empty{color:var(--dim)}
.stat.big b{font-size:34px}
.grid.headline{margin-bottom:6px}
.unavail{color:var(--warn);font-size:12px;margin:4px 0 16px;line-height:1.5}
.prov{color:var(--dim);font-size:12px;margin:6px 0 22px;line-height:1.5}
.sev-critical{color:var(--bad);font-weight:700}
.sev-high{color:var(--warn);font-weight:700}
.sev-medium{color:var(--dim)}
.fixed{color:var(--good)}
.stillbad{color:var(--bad)}
footer{color:var(--dim);font-size:11px;margin-top:32px;border-top:1px solid var(--line);padding-top:12px}
</style></head>
<body><main>
<h1>usewarden <span class="state ${stateClass}">${esc(d.overall)}</span></h1>
<p style="color:var(--dim);margin:0">Read-only. Bound to 127.0.0.1. No external assets.</p>

${valueSection(d.value)}

<h2 style="font-size:13px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em">Activity <span style="text-transform:none;letter-spacing:0;font-weight:400">&mdash; how often it fired, which is not how often it was right</span></h2>
<div class="grid">
  <div class="stat"><b>${d.metrics.live.attempts}</b><span>actions blocked (real sessions)</span></div>
  <div class="stat"><b>${d.metrics.live.distinct_actions}</b><span>distinct actions blocked</span></div>
  <div class="stat"><b>${d.metrics.live.drift_warnings}</b><span>drift warnings</span></div>
  <div class="stat"><b>${d.metrics.live.events}</b><span>events inspected</span></div>
  <div class="stat"><b>$${d.judgeUsd.toFixed(4)}</b><span>guardian overhead (metered)</span></div>
  <div class="stat"><b>${d.judgeUnmetered}</b><span>judge calls on a local CLI (unpriced)</span></div>
</div>
<p style="color:var(--dim);margin:0 0 24px;font-size:12px">
Estimated saved: <b>${esc(fmtTokenBand(d.metrics.savings.tokens))}</b> &middot; <b>${esc(fmtUsdBand(d.metrics.savings.usd))}</b>.
An estimate from assumed bands, not a measurement &mdash; ${d.metrics.savings.unpriced_actions} further
catch(es) are counted but deliberately never priced. Method: <code>usewarden metrics</code>, docs/METRICS.md.
${d.metrics.integrity.consistent ? '' : '<br><b style="color:var(--bad)">METRICS INCONSISTENT: ' + esc(d.metrics.integrity.problems.join('; ')) + '</b>'}
</p>
${d.metrics.demo.incidents > 0 ? `<p style="color:var(--dim);margin:0 0 24px;font-size:12px">${d.metrics.demo.attempts} further block(s) came from <code>usewarden demo</code> and are excluded from every figure above.</p>` : ''}

<h2 style="font-size:13px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em">Getting started</h2>
<ul class="check">${d.checklist.map((c) => `<li class="${c.done ? 'done' : ''}">${c.done ? '[x]' : '[ ]'} ${esc(c.label)}</li>`).join('')}</ul>

<h2 style="font-size:13px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em">Agents</h2>
<div class="tablewrap"><table><thead><tr><th>agent</th><th>state</th><th>config</th></tr></thead><tbody>
${d.agents.map((a) => `<tr><td>${esc(a.label)}</td><td style="color:${a.state === 'PROTECTED' ? 'var(--good)' : 'var(--bad)'}">${esc(a.state)}</td><td style="color:var(--dim)">${esc(a.configPath)}</td></tr>`).join('')}
</tbody></table></div>

<h2 style="font-size:13px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em">Incident wall</h2>
${cards}

<footer>generated ${esc(new Date(d.generatedAt).toISOString())} &middot; usewarden refreshes every 5s</footer>
</main>
<script>
setTimeout(function(){ location.reload(); }, 5000);
</script>
</body></html>`;
}

export async function serveDashboard(flags: Set<string>, args: string[]): Promise<number> {
  const portArg = args[1];
  const port = portArg && /^\d+$/.test(portArg) ? Number(portArg) : 0;
  const h = await startDashboard(port);
  if (flags.has('--json')) {
    process.stdout.write(JSON.stringify({ url: h.url, port: h.port }) + '\n');
  } else {
    process.stdout.write('\n' + head('  usewarden dashboard') + '\n');
    process.stdout.write('  ' + ok(h.url) + '\n');
    process.stdout.write(dim('  Loopback only. The token in the URL is required and changes every run.\n'));
    process.stdout.write(dim('  Ctrl-C to stop.\n\n'));
  }
  if (flags.has('--once')) { await h.close(); return 0; }
  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => { void h.close().then(resolve); });
    process.on('SIGTERM', () => { void h.close().then(resolve); });
  });
  return 0;
}
