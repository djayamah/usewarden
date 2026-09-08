import * as http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { AggregateDb } from './db.js';
import { MAX_BODY_BYTES, validate } from './validate.js';

/**
 * The usewarden telemetry aggregation service.
 *
 * ============================================================================================
 * THIS IS BUILT AND TESTED. IT IS NOT DEPLOYED, AND NOTHING IN THIS REPOSITORY DEPLOYS IT.
 * The usewarden CLI ships no endpoint; `endpoint()` in src/telemetry.ts returns null unless a
 * user sets `USEWARDEN_TELEMETRY_ENDPOINT` themselves. See service/README.md.
 * ============================================================================================
 *
 * Design constraints, in the order they mattered:
 *
 *  1. **It stores no identifier.** There is no install id, no cookie, no fingerprint, and no IP
 *     column. A submission is folded into a daily aggregate bucket on arrival and its individual
 *     shape ceases to exist. You cannot deanonymise a database whose rows were never written.
 *
 *  2. **Rate limiting must not become tracking.** A limiter needs to tell submitters apart,
 *     which is exactly the capability the service otherwise refuses to have. So the limiter
 *     keys on a SALTED HASH of the remote address, held in memory only, with a salt generated
 *     fresh at startup and never persisted. The window is evicted as it expires. Nothing about
 *     it survives a restart, reaches disk, or reaches a log line.
 *
 *  3. **Logs carry reason codes, never content.** A log line is method, path, status, and one
 *     fixed reason code from usewarden's own vocabulary. No body, no address, no header.
 *
 *  4. **Nothing the client says is trusted**, including counts. See validate.ts.
 */

export interface ServerOptions {
  db?: AggregateDb;
  /** Injected so tests are hermetic and so a day boundary can be exercised. */
  now?: () => number;
  /** Submissions allowed per window per salted-hash key. */
  rateLimit?: number;
  rateWindowMs?: number;
  /**
   * HARD global ceiling on accepted submissions per UTC day, across all submitters.
   * See `DAILY_INGEST_CEILING`. Set to 0 to disable, which no deployment should do.
   */
  dailyIngestCeiling?: number;
  /** Called with one fixed reason code per request. Defaults to silence. */
  log?: (line: string) => void;
}

/**
 * THE BILL IS THE OPERATOR'S, NOT THE USER'S.
 *
 * Every other limit in this service protects the submitter's privacy. This one protects the
 * person paying for the box, and it is the control that decides whether this service can ever
 * be safely deployed at all: an open ingest endpoint with no global ceiling is an invitation to
 * convert somebody else's spare bandwidth into your invoice.
 *
 * The per-submitter rate limit is NOT sufficient for that. It is keyed on a salted hash of the
 * remote address, deliberately amnesiac (see the limiter below), and therefore trivially evaded
 * by anyone with a handful of addresses. It exists to stop accidents and single-source floods.
 * The global ceiling is what stops the bill.
 *
 * The default is sized from the cost model in `service/README.md`: at 10,000 installs reporting
 * once a day, 20,000/day is 2x expected volume, and the worst case it admits is small enough to
 * be a rounding error on any host. Past it, the service returns 503 and folds NOTHING - it does
 * not queue, retry, or buffer, because a queue is just a slower way to spend the same money.
 *
 * The client is built for exactly this: 2-second timeout, zero retries, fire-and-forget. A 503
 * is discarded silently and the user never notices.
 */
export const DAILY_INGEST_CEILING = 20_000;

export interface ServerHandle {
  port: number;
  url: string;
  db: AggregateDb;
  /** The global daily ceiling this instance is enforcing. */
  ceiling: number;
  /** Submissions accepted so far in the current UTC day. */
  acceptedToday(): number;
  close(): Promise<void>;
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * In-memory, salted, ephemeral. See constraint 2 above. The salt never leaves this process and
 * is regenerated on every start, so two runs of the service cannot correlate the same submitter.
 */
class EphemeralLimiter {
  private readonly salt = randomBytes(32);
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly limit: number, private readonly windowMs: number) {}

  allow(remote: string | undefined, now: number): boolean {
    if (this.limit <= 0) return true;
    const key = createHash('sha256').update(this.salt).update(remote ?? '').digest('base64');
    const cutoff = now - this.windowMs;
    const times = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (times.length >= this.limit) { this.hits.set(key, times); return false; }
    times.push(now);
    this.hits.set(key, times);
    if (this.hits.size > 10_000) this.evict(cutoff);
    return true;
  }

  private evict(cutoff: number): void {
    for (const [k, v] of this.hits) {
      const kept = v.filter((t) => t > cutoff);
      if (kept.length === 0) this.hits.delete(k); else this.hits.set(k, kept);
    }
  }
}

const SECURITY_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
} as const;

export async function startService(port = 0, opts: ServerOptions = {}): Promise<ServerHandle> {
  const db = opts.db ?? new AggregateDb();
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((): void => { /* silent by default */ });
  const limiter = new EphemeralLimiter(opts.rateLimit ?? 60, opts.rateWindowMs ?? 60_000);
  const ceiling = opts.dailyIngestCeiling ?? DAILY_INGEST_CEILING;
  // Accepted submissions in the current UTC day. Reset when the day rolls over; never persisted,
  // because a restart that forgets the count is strictly safer than one that cannot start.
  let ingestDay = '';
  let ingestToday = 0;

  const server = http.createServer((req, res) => {
    const send = (code: number, body: unknown, reason: string): void => {
      res.writeHead(code, { ...SECURITY_HEADERS });
      res.end(JSON.stringify(body) + '\n');
      // reason is a fixed code from our own vocabulary - never anything from the request.
      log(`${req.method ?? '?'} ${(req.url ?? '/').split('?')[0]} ${code} ${reason}`);
    };

    const path = (req.url ?? '/').split('?')[0];

    if (req.method === 'GET' && path === '/v1/health') {
      return send(200, { ok: true }, 'health');
    }
    if (req.method === 'GET' && path === '/v1/stats') {
      return send(200, db.stats(), 'stats');
    }
    if (path !== '/v1/telemetry') return send(404, { ok: false, reason: 'not_found' }, 'not_found');
    if (req.method !== 'POST') return send(405, { ok: false, reason: 'method_not_allowed' }, 'method_not_allowed');

    // Global ceiling BEFORE the per-submitter limit and before reading a single byte of body.
    // A ceiling that is checked after the work is not a ceiling on the work.
    const today = utcDay(now());
    if (today !== ingestDay) { ingestDay = today; ingestToday = 0; }
    if (ceiling > 0 && ingestToday >= ceiling) {
      db.recordRejection('daily_ceiling_reached', today);
      return send(503, {
        ok: false, reason: 'daily_ceiling_reached',
        detail: 'This aggregator has accepted its maximum submissions for today. Nothing is wrong with your install.',
      }, 'daily_ceiling_reached');
    }

    if (!limiter.allow(req.socket.remoteAddress, now())) {
      return send(429, { ok: false, reason: 'rate_limited' }, 'rate_limited');
    }

    // Cap enforced WHILE reading, not after. A body cap checked after buffering is not a cap.
    let size = 0;
    const chunks: Buffer[] = [];
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        db.recordRejection('body_too_large', utcDay(now()));
        send(413, { ok: false, reason: 'body_too_large' }, 'body_too_large');
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      const day = utcDay(now());
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        db.recordRejection('bad_json', day);
        return send(400, { ok: false, reason: 'bad_json' }, 'bad_json');
      }
      const result = validate(parsed);
      if (!result.ok) {
        db.recordRejection(result.reason, day);
        return send(400, { ok: false, reason: result.reason }, result.reason);
      }
      db.fold(result.payload, day);
      ingestToday += 1;
      return send(202, { ok: true }, 'accepted');
    });
    req.on('error', () => { aborted = true; });
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    port: boundPort,
    url: `http://127.0.0.1:${boundPort}`,
    db,
    ceiling,
    acceptedToday: () => ingestToday,
    close: () => new Promise<void>((resolve) => {
      server.close(() => { if (!opts.db) db.close(); resolve(); });
      server.closeAllConnections?.();
    }),
  };
}
