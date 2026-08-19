import { displayPath } from './util.js';
import * as http from 'node:http';
import { randomBytes } from 'node:crypto';
import { Store } from './store.js';
import { buildStatus } from './status.js';
import { head, dim, ok } from './term.js';

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
  liveCatches: number;
  totalCatches: number;
  judgeUsd: number;
  judgeUnmetered: number;
  checklist: { label: string; done: boolean }[];
  contextWarnPct: number;
  incidents: {
    ts: number; agent: string; action: string; title: string; attempted: string;
    reason: string; rule: string; live: number; layer: number; severity: string;
  }[];
  generatedAt: number;
}

export function snapshot(store: Store): Snapshot {
  const r = buildStatus(store, process.cwd());
  return {
    overall: r.overall,
    agents: r.agents.map((a) => ({ label: a.label, state: a.state, configPath: displayPath(a.configPath) })),
    counters: r.counters,
    liveCatches: r.liveCatches,
    totalCatches: r.totalCatches,
    judgeUsd: r.judge.usd,
    judgeUnmetered: r.judge.unmetered,
    checklist: r.checklist.map((c) => ({ label: c.label, done: c.done })),
    contextWarnPct: 60,
    incidents: store.recentIncidents(50).map((i) => ({
      ts: i.ts, agent: i.agent, action: i.action, title: i.title,
      attempted: displayPath(i.attempted), reason: displayPath(i.reason),
      rule: i.rule, live: i.live, layer: i.layer, severity: i.severity,
    })),
    generatedAt: Date.now(),
  };
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
          <dt>agent</dt><dd>${esc(i.agent)} ${i.live ? '<span class="live">live session</span>' : '<span class="fixture">fixture</span>'}</dd>
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
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:24px 0}
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
footer{color:var(--dim);font-size:11px;margin-top:32px;border-top:1px solid var(--line);padding-top:12px}
</style></head>
<body><main>
<h1>usewarden <span class="state ${stateClass}">${esc(d.overall)}</span></h1>
<p style="color:var(--dim);margin:0">Read-only. Bound to 127.0.0.1. No external assets.</p>

<div class="grid">
  <div class="stat"><b>${d.counters['actions_blocked'] ?? 0}</b><span>actions blocked</span></div>
  <div class="stat"><b>${d.counters['drift_caught'] ?? 0}</b><span>drift warnings</span></div>
  <div class="stat"><b>${d.liveCatches}</b><span>catches in real sessions</span></div>
  <div class="stat"><b>${d.counters['events_seen'] ?? 0}</b><span>events inspected</span></div>
  <div class="stat"><b>$${d.judgeUsd.toFixed(4)}</b><span>guardian overhead (metered)</span></div>
  <div class="stat"><b>${d.judgeUnmetered}</b><span>judge calls on a local CLI (unpriced)</span></div>
</div>

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
