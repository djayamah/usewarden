import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AggregateDb, K_ANONYMITY_THRESHOLD } from '../service/src/db.js';
import { looksLikeUserData, MAX_BODY_BYTES, validate, type ValidPayload } from '../service/src/validate.js';
import { DAILY_INGEST_CEILING, startService, utcDay, type ServerHandle } from '../service/src/server.js';

/**
 * The aggregation service. Built and tested; NOT deployed - see service/README.md.
 *
 * Every rejection test asserts the sabotage LANDED first: that the hostile field really is in
 * the payload being submitted. A validation test that passes because the fixture was silently
 * malformed proves nothing at all.
 */

const GOOD: ValidPayload = {
  v: 1,
  usewarden: '0.1.0',
  platform: 'darwin',
  node: '22',
  agents: ['claude'],
  counts: { events_seen: 100, actions_blocked: 4, drift_caught: 1, sessions: 7, live_catches: 5 },
  rules: { 'dotenv-access': 3, 'scope.allowed_paths': 1 },
  checklist: ['agents_detected', 'policy_created'],
};

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const clone = (): ValidPayload => JSON.parse(JSON.stringify(GOOD)) as ValidPayload;

describe('service: payload validation', () => {
  test('the known-good payload is accepted', () => {
    const r = validate(clone());
    assert.equal(r.ok, true, r.ok ? '' : `rejected: ${r.reason}`);
  });

  test('an UNKNOWN top-level key is a rejection, not an ignored extra', () => {
    const p = clone() as unknown as Record<string, unknown>;
    p['transcript'] = 'const secret = 1';
    // sabotage landed:
    assert.equal(Object.keys(p).includes('transcript'), true, 'setup failed - no extra key');
    const r = validate(p);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, 'unknown_or_missing_top_level_key');
  });

  test('a MISSING documented key is a rejection', () => {
    const p = clone() as unknown as Record<string, unknown>;
    delete p['rules'];
    assert.equal('rules' in p, false, 'setup failed - the key is still there');
    assert.equal(validate(p).ok, false);
  });

  test('an unknown key inside counts is a rejection', () => {
    const p = clone();
    (p.counts as unknown as Record<string, unknown>)['tokens_of_your_source'] = 5;
    assert.equal('tokens_of_your_source' in p.counts, true, 'setup failed');
    const r = validate(p);
    assert.equal(r.ok === false && r.reason, 'unknown_or_missing_count_key');
  });

  test('a rule label carrying a path or a credential is refused', () => {
    for (const hostile of ['/Users/me/secret/.env', 'sk-ant-NOT-A-REAL-KEY', 'https://evil.invalid', 'a'.repeat(60)]) {
      const p = clone();
      p.rules = { [hostile]: 1 };
      assert.equal(Object.keys(p.rules)[0], hostile, 'setup failed - the hostile label is not in the payload');
      const r = validate(p);
      assert.equal(r.ok, false, `${hostile} was accepted`);
      assert.equal(r.ok === false && r.reason, 'unsafe_rule_label');
    }
  });

  test('the content gate catches user data even where the schema would not', () => {
    assert.equal(looksLikeUserData('dotenv-access'), false);
    assert.equal(looksLikeUserData('/etc/passwd'), true);
    assert.equal(looksLikeUserData('me@example.com'), true);
    assert.equal(looksLikeUserData('fix the bug in parser'), true, 'free text has spaces');
    assert.equal(looksLikeUserData('https://x.invalid'), true);
    assert.equal(looksLikeUserData('x'.repeat(65)), true);
  });

  /**
   * INFLATION, at the wire. This is the client-side defect of docs/METRICS.md section 1
   * arriving from outside, and the server must refuse it for the same reason: a guardian
   * cannot block what it never inspected, so the number is not evidence of anything.
   */
  test('a payload claiming more blocked actions than inspected events is refused', () => {
    const p = clone();
    p.counts.events_seen = 8;
    p.counts.actions_blocked = 12;
    assert.ok(p.counts.actions_blocked > p.counts.events_seen, 'setup failed - the payload is not inflated');
    const r = validate(p);
    assert.equal(r.ok === false && r.reason, 'inconsistent_counts');
  });

  test('rule hits totalling more than the events seen are refused', () => {
    const p = clone();
    p.counts.events_seen = 5;
    p.counts.actions_blocked = 1;
    p.counts.drift_caught = 0;
    p.counts.sessions = 1;
    p.counts.live_catches = 1;
    p.rules = { 'dotenv-access': 9999 };
    assert.ok(p.rules['dotenv-access']! > p.counts.events_seen, 'setup failed');
    assert.equal(validate(p).ok, false);
  });

  test('an absurd magnitude is refused', () => {
    const p = clone();
    p.counts.events_seen = 999_999_999;
    assert.equal(validate(p).ok, false);
  });

  test('a negative or fractional count is refused', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const p = clone();
      (p.counts as unknown as Record<string, unknown>)['actions_blocked'] = bad;
      assert.equal(validate(p).ok, false, `${String(bad)} was accepted`);
    }
  });

  test('too many rule keys is refused', () => {
    const p = clone();
    p.rules = {};
    p.counts.events_seen = 10_000;
    for (let i = 0; i < 41; i++) p.rules[`rule-${i}`] = 1;
    assert.equal(Object.keys(p.rules).length, 41, 'setup failed');
    assert.equal(validate(p).ok === false && (validate(p) as { reason: string }).reason, 'too_many_rule_keys');
  });

  test('an unknown agent id, platform, or checklist step is refused', () => {
    const bad: [keyof ValidPayload, unknown][] = [
      ['agents', ['not-an-agent']],
      ['platform', 'haiku-os'],
      ['checklist', ['send_us_your_repo']],
      ['node', '22.1.0'],
      ['v', 2],
    ];
    for (const [key, value] of bad) {
      const p = clone() as unknown as Record<string, unknown>;
      p[key] = value;
      assert.equal(validate(p).ok, false, `${key}=${JSON.stringify(value)} was accepted`);
    }
  });

  test('arrays and primitives are not payloads', () => {
    for (const junk of [[], 'x', 5, null, true]) assert.equal(validate(junk).ok, false);
  });
});

describe('service: aggregate storage', () => {
  let db: AggregateDb;
  beforeEach(() => { db = new AggregateDb(); });
  afterEach(() => { db.close(); });

  test('no table in the schema has a column that could identify an install', () => {
    const tables = db.db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[];
    assert.ok(tables.length > 0, 'setup failed - no tables');
    const forbidden = /(ip|addr|host|user|install|client|machine|fingerprint|session_id|uuid)/i;
    for (const t of tables) {
      const cols = db.db.prepare(`PRAGMA table_info(${t.name})`).all() as { name: string }[];
      for (const c of cols) {
        assert.equal(forbidden.test(c.name), false,
          `${t.name}.${c.name} looks like an identifier - this service must not be able to tell installs apart`);
      }
    }
  });

  test('folding sums into a daily bucket and never keeps the submission', () => {
    db.fold(clone(), '2026-08-20');
    db.fold(clone(), '2026-08-20');
    const rows = db.db.prepare('SELECT * FROM buckets').all() as unknown as { submissions: number; events_seen: number }[];
    assert.equal(rows.length, 1, 'two identical submissions must share one bucket');
    assert.equal(Number(rows[0]!.submissions), 2);
    assert.equal(Number(rows[0]!.events_seen), 200);
  });

  test('a thin bucket is SUPPRESSED from stats, and the suppression is visible', () => {
    db.fold(clone(), '2026-08-20');
    const s = db.stats();
    assert.equal(s.buckets.length, 0, 'a bucket of one describes one machine and must not be published');
    assert.equal(s.suppressed_buckets, 1, 'suppression must be counted, not silent');
    assert.equal(s.threshold, K_ANONYMITY_THRESHOLD);
  });

  test('a bucket at the threshold is published', () => {
    for (let i = 0; i < K_ANONYMITY_THRESHOLD; i++) db.fold(clone(), '2026-08-20');
    const s = db.stats();
    assert.equal(s.buckets.length, 1);
    assert.equal(s.suppressed_buckets, 0);
    assert.equal(s.buckets[0]!.submissions, K_ANONYMITY_THRESHOLD);
  });

  test('rejections are counted by reason code with no trace of the payload', () => {
    db.recordRejection('unsafe_rule_label', '2026-08-20');
    db.recordRejection('unsafe_rule_label', '2026-08-20');
    const s = db.stats();
    assert.deepEqual(s.rejections.map((r) => [r.reason, Number(r.n)]), [['unsafe_rule_label', 2]]);
  });
});

describe('service: HTTP surface', () => {
  let h: ServerHandle;
  let clock = Date.parse('2026-08-20T12:00:00Z');
  const logged: string[] = [];

  beforeEach(async () => {
    clock = Date.parse('2026-08-20T12:00:00Z');
    logged.length = 0;
    h = await startService(0, { now: () => clock, log: (l) => logged.push(l) });
  });
  afterEach(async () => { await h.close(); });

  const post = async (body: string | object, path = '/v1/telemetry'): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await fetch(h.url + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() as Record<string, unknown> };
  };

  test('it binds loopback only', () => {
    assert.match(h.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test('health and stats answer; an unknown path is 404', async () => {
    assert.equal((await fetch(h.url + '/v1/health')).status, 200);
    assert.equal((await fetch(h.url + '/v1/stats')).status, 200);
    assert.equal((await fetch(h.url + '/')).status, 404);
    assert.equal((await fetch(h.url + '/v1/telemetry')).status, 405, 'GET on the ingest path is not allowed');
  });

  test('every response carries the security headers, including the 404', async () => {
    for (const p of ['/v1/health', '/nope']) {
      const res = await fetch(h.url + p);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', p);
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer', p);
      assert.equal(res.headers.get('cache-control'), 'no-store', p);
      assert.equal(res.headers.get('access-control-allow-origin'), null, `${p} must not be CORS-readable`);
    }
  });

  test('a good payload is accepted and folded', async () => {
    const r = await post(GOOD);
    assert.equal(r.status, 202);
    assert.equal(r.json['ok'], true);
    const rows = h.db.db.prepare('SELECT submissions FROM buckets').all() as { submissions: number }[];
    assert.equal(Number(rows[0]?.submissions), 1);
  });

  test('a hostile payload is refused with a reason code and stored nowhere', async () => {
    const p = clone() as unknown as Record<string, unknown>;
    p['prompt'] = 'the whole user prompt';
    const r = await post(p);
    assert.equal(r.status, 400);
    assert.equal(r.json['reason'], 'unknown_or_missing_top_level_key');
    const rows = h.db.db.prepare('SELECT COUNT(*) AS c FROM buckets').get() as { c: number };
    assert.equal(Number(rows.c), 0, 'a refused payload must leave no bucket behind');
    // The rejection is counted; the content is not anywhere.
    const dump = JSON.stringify(h.db.stats());
    assert.equal(dump.includes('the whole user prompt'), false, 'the payload content survived somewhere');
  });

  test('malformed JSON is a clean 400, not a crash', async () => {
    const r = await post('{not json');
    assert.equal(r.status, 400);
    assert.equal(r.json['reason'], 'bad_json');
    assert.equal((await fetch(h.url + '/v1/health')).status, 200, 'the service must still be up');
  });

  test('an oversized body is cut off WHILE reading, not after', async () => {
    const p = clone();
    p.rules = {};
    // ~40KB of body, five times the cap.
    for (let i = 0; i < 6000; i++) p.rules[`rule-${i}`] = 1;
    const body = JSON.stringify(p);
    assert.ok(body.length > MAX_BODY_BYTES * 4, 'setup failed - the body is not oversized');
    const res = await fetch(h.url + '/v1/telemetry', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    }).catch(() => null);
    // Either a 413 arrives or the socket is destroyed mid-upload; both are the cap working.
    if (res) assert.equal(res.status, 413);
    assert.equal((await fetch(h.url + '/v1/health')).status, 200, 'the service must still be up');
  });

  test('a flood is rate limited', async () => {
    const tight = await startService(0, { now: () => clock, rateLimit: 3, rateWindowMs: 60_000 });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await fetch(tight.url + '/v1/telemetry', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(GOOD),
        });
        codes.push(res.status);
        await res.arrayBuffer();
      }
      assert.deepEqual(codes.slice(0, 3), [202, 202, 202]);
      assert.deepEqual(codes.slice(3), [429, 429, 429], 'the flood must be refused after the limit');
      const rows = tight.db.db.prepare('SELECT submissions FROM buckets').all() as { submissions: number }[];
      assert.equal(Number(rows[0]?.submissions), 3, 'rate-limited submissions must not be folded');
    } finally { await tight.close(); }
  });

  test('logs carry a reason code and never the payload or an address', async () => {
    const p = clone();
    p.rules = { '/Users/someone/secret/.env': 1 };
    await post(p);
    await post(GOOD);
    assert.ok(logged.length >= 2, 'nothing was logged');
    const all = logged.join('\n');
    assert.match(all, /unsafe_rule_label/);
    assert.match(all, /accepted/);
    assert.equal(all.includes('secret'), false, 'the payload reached a log line');
    assert.equal(all.includes('127.0.0.1'), false, 'a remote address reached a log line');
  });

  test('submissions land in the UTC day bucket they arrived in', async () => {
    await post(GOOD);
    clock = Date.parse('2026-08-21T00:00:01Z');
    await post(GOOD);
    const days = (h.db.db.prepare('SELECT day FROM buckets ORDER BY day').all() as { day: string }[]).map((d) => d.day);
    assert.deepEqual(days, ['2026-08-20', '2026-08-21']);
    assert.equal(utcDay(Date.parse('2026-08-20T23:59:59Z')), '2026-08-20');
  });
});

describe('service: the global cost ceiling', () => {
  /**
   * This is the control that decides whether the service can be deployed at all. The
   * per-submitter rate limit is keyed on a salted hash of the remote address and is deliberately
   * amnesiac, which is right for privacy and means it is trivially evaded by anyone with a few
   * addresses. It bounds accidents. Only the global ceiling bounds the BILL.
   */
  test('a default ceiling exists and is not effectively infinite', () => {
    assert.equal(typeof DAILY_INGEST_CEILING, 'number');
    assert.ok(DAILY_INGEST_CEILING > 0, 'a service with no ceiling cannot be safely deployed');
    assert.ok(DAILY_INGEST_CEILING <= 100_000,
      'a ceiling this high is not a ceiling - see the cost table in service/README.md');
  });

  test('past the ceiling: 503, nothing folded, and the rejection is counted', async () => {
    let clock = Date.parse('2026-08-20T12:00:00Z');
    // rateLimit 0 disables the per-submitter limit, isolating the global ceiling.
    const h = await startService(0, { now: () => clock, dailyIngestCeiling: 2, rateLimit: 0 });
    try {
      const post = async (): Promise<number> => {
        const res = await fetch(h.url + '/v1/telemetry', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(GOOD),
        });
        await res.arrayBuffer();
        return res.status;
      };
      assert.deepEqual([await post(), await post()], [202, 202]);
      // sabotage landed: the ceiling really has been reached.
      assert.equal(h.acceptedToday(), 2, 'setup failed - the ceiling was not reached');

      assert.equal(await post(), 503, 'the ceiling did not stop the third submission');
      assert.equal(await post(), 503);
      assert.equal(h.acceptedToday(), 2, 'a refused submission was counted as accepted');

      const rows = h.db.db.prepare('SELECT SUM(submissions) AS n FROM buckets').get() as { n: number };
      assert.equal(Number(rows.n), 2, 'a refused submission was folded into the aggregate anyway');

      const rejected = h.db.stats().rejections.find((r) => r.reason === 'daily_ceiling_reached');
      assert.ok(rejected, 'hitting the ceiling must be visible to an operator');
      assert.equal(Number(rejected.n), 2);
    } finally { await h.close(); }
  });

  test('the ceiling resets when the UTC day rolls over', async () => {
    let clock = Date.parse('2026-08-20T23:59:00Z');
    const h = await startService(0, { now: () => clock, dailyIngestCeiling: 1, rateLimit: 0 });
    try {
      const post = async (): Promise<number> => {
        const res = await fetch(h.url + '/v1/telemetry', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(GOOD),
        });
        await res.arrayBuffer();
        return res.status;
      };
      assert.equal(await post(), 202);
      assert.equal(await post(), 503, 'setup failed - the ceiling did not engage');

      clock = Date.parse('2026-08-21T00:00:01Z');
      assert.equal(await post(), 202, 'the ceiling must reset at the UTC day boundary');
      assert.equal(h.acceptedToday(), 1, 'the counter must reset, not accumulate');
    } finally { await h.close(); }
  });

  test('the 503 tells the user nothing is wrong with their install', async () => {
    const clock = Date.parse('2026-08-20T12:00:00Z');
    const h = await startService(0, { now: () => clock, dailyIngestCeiling: 1, rateLimit: 0 });
    try {
      await (await fetch(h.url + '/v1/telemetry', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(GOOD),
      })).arrayBuffer();
      const res = await fetch(h.url + '/v1/telemetry', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(GOOD),
      });
      const body = await res.json() as Record<string, unknown>;
      assert.equal(res.status, 503);
      assert.equal(body['reason'], 'daily_ceiling_reached');
      assert.match(String(body['detail']), /Nothing is wrong with your install/);
    } finally { await h.close(); }
  });

  test('the documented cost table names every scale the ceiling is justified against', () => {
    const doc = fs.readFileSync(path.join(REPO_ROOT, 'service', 'README.md'), 'utf8');
    for (const scale of ['100', '1,000', '10,000']) {
      assert.ok(doc.includes(scale), `the cost table does not cover ${scale} installs`);
    }
    assert.match(doc, /Worst-case monthly cost/);
    assert.match(doc, new RegExp(String(DAILY_INGEST_CEILING).replace(/(\d)(?=(\d{3})+$)/g, '$1,')),
      'the documented ceiling must match the code');
  });
});
