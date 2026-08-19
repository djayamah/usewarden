import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { Store } from '../src/store.js';
import { startDashboard, renderHtml, snapshot, type DashboardHandle } from '../src/dashboard.js';
import { sandbox, gitInit, type Sandbox } from './helpers.js';

let sb: Sandbox;
let store: Store;
let dash: DashboardHandle;

beforeEach(async () => {
  sb = sandbox();
  gitInit(sb.repo);
  store = new Store(path.join(sb.usewardenHome, 'w.db'));
  store.addIncident({
    sessionId: 's', agent: 'claude', ts: Date.now(), layer: 1, severity: 'block', action: 'block',
    rule: 'commands.deny[6] (dotenv-access)', title: 'Blocked command: dotenv-access',
    attempted: '$ cat .env', reason: 'Usewarden: .env access is blocked.',
    tool: 'Bash', target: '.env', cwd: sb.repo,
  }, true);
  dash = await startDashboard(0, store);
});
afterEach(async () => { await dash.close(); store.close(); sb.cleanup(); });

async function get(url: string): Promise<Response> {
  return fetch(url, { redirect: 'manual' });
}

describe('T-13: dashboard security posture', () => {
  test('binds to loopback only', () => {
    assert.match(dash.url, /^http:\/\/127\.0\.0\.1:\d+\//);
  });

  test('a request without the per-session token gets nothing', async () => {
    const bare = dash.url.replace(/\?t=.*$/, '');
    const res = await get(bare);
    assert.equal(res.status, 404);
    const body = await res.text();
    assert.equal(body.includes('incident'), false, 'no data may leak on the unauthorised path');
  });

  test('a wrong token gets nothing', async () => {
    const res = await get(dash.url.replace(/t=.*$/, 't=wrong'));
    assert.equal(res.status, 404);
  });

  test('the token is long and random per run', async () => {
    assert.ok(dash.token.length >= 24, `token too short: ${dash.token.length}`);
    const second = await startDashboard(0, store);
    assert.notEqual(second.token, dash.token);
    await second.close();
  });

  test('read-only: every mutating method is refused', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(dash.url, { method });
      assert.equal(res.status, 405, `${method} must be refused`);
    }
  });

  test('strict CSP and hardening headers on every response', async () => {
    for (const url of [dash.url, dash.url.replace('/?', '/api?'), dash.url.replace(/t=.*$/, 't=bad')]) {
      const res = await get(url);
      const csp = res.headers.get('content-security-policy') ?? '';
      assert.match(csp, /default-src 'none'/, `missing CSP on ${url}`);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(res.headers.get('access-control-allow-origin'), null, 'no CORS, ever');
    }
  });

  test('the served page references no external asset', async () => {
    const html = await (await get(dash.url)).text();
    const external = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]!);
    for (const u of external) {
      assert.equal(/^(https?:)?\/\//.test(u), false, `external asset reference: ${u}`);
    }
    assert.equal(/@import|url\(\s*["']?https?:/.test(html), false, 'no remote CSS import');
    assert.equal(html.includes('fonts.googleapis.com'), false);
  });

  test('the api route serves the same read-only snapshot as JSON', async () => {
    const res = await get(dash.url.replace('/?', '/api?'));
    assert.equal(res.status, 200);
    const j = await res.json() as { incidents: unknown[]; overall: string };
    assert.equal(Array.isArray(j.incidents), true);
    assert.equal(j.incidents.length, 1);
  });
});

describe('dashboard rendering', () => {
  test('incident content is HTML-escaped', () => {
    store.addIncident({
      sessionId: 's', agent: 'claude', ts: Date.now(), layer: 1, severity: 'block', action: 'block',
      rule: 'r', title: '<script>alert(1)</script>',
      attempted: '$ echo "<img src=x onerror=alert(2)>"', reason: 'x & y',
      tool: 'Bash', target: 't', cwd: sb.repo,
    }, false);
    const html = renderHtml(snapshot(store), 'tok');
    // The substring `onerror=alert(2)` legitimately survives escaping - `=` is not a special
    // character. What must NOT survive is any way for it to become an attribute or a tag, so
    // assert on the angle brackets and quotes that would be required to escape the text node.
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, 'title must be entity-encoded');
    assert.match(html, /&lt;img src=x onerror=alert\(2\)&gt;/, 'attempt must be entity-encoded');
    assert.equal(html.includes('<script>alert(1)'), false, 'no injected script tag');
    assert.equal(html.includes('<img'), false, 'no injected img tag');
    // The only <script> in the document is usewarden's own inline reload timer.
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    assert.equal(scripts.length, 1);
    assert.match(scripts[0]!, /location\.reload/);
  });

  test('theme override produces genuinely different documents', () => {
    const snap = snapshot(store);
    const dark = renderHtml(snap, 't', 'dark');
    const light = renderHtml(snap, 't', 'light');
    assert.match(dark, /data-theme="dark"/);
    assert.match(light, /data-theme="light"/);
    assert.notEqual(dark, light);
  });

  test('an unrecognised theme value is ignored rather than injected', () => {
    const html = renderHtml(snapshot(store), 't', '"><script>x</script>');
    assert.equal(html.includes('<script>x</script>'), false);
    // `data-theme=` appears inside the stylesheet selectors, so assert on the HTML ATTRIBUTE.
    assert.equal(/<html[^>]*data-theme=/.test(html), false, 'only "dark" and "light" may reach the html tag');
  });

  test('the checklist and the live-catch count both appear', () => {
    const html = renderHtml(snapshot(store), 't');
    assert.match(html, /First catch in a real session/);
    assert.match(html, /catches in real sessions/);
  });
});
