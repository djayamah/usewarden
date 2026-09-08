# usewarden telemetry aggregation service

> ## THIS SERVICE IS NOT DEPLOYED.
>
> It is built, tested, and sitting still. Nothing in this repository deploys it: there is no
> Dockerfile, no compose file, no Terraform, no CI deploy job, and no hostname anywhere in the
> usewarden client. `endpoint()` in `src/telemetry.ts` returns `null` unless a user sets
> `USEWARDEN_TELEMETRY_ENDPOINT` themselves, so a default install has nowhere to send a payload
> even if telemetry were on — which it is not, by default.
>
> Deploying it is a founder decision and a founder action. §"If you ever deploy this" below is
> the checklist for that day.

Not shipped in the npm package either — `package.json`'s `files` allowlist covers `dist/src` and
metadata only, and a test asserts that `service/` never appears in the tarball.

---

## What it is

A single-process HTTP service that accepts the payload documented in `docs/TELEMETRY.md`, folds
it into a daily aggregate bucket, and serves the aggregate back. Zero runtime dependencies:
`node:http` and `node:sqlite`, the same two the CLI uses.

```
service/src/validate.ts   strict payload validation and the content gate
service/src/db.ts         aggregate-only storage, k-anonymity on read
service/src/server.ts     the HTTP surface, rate limiting, security headers
tests/service.test.ts     the suite, including the counter sabotage cases
```

## Endpoints

| Method | Path | Behaviour |
|---|---|---|
| `POST` | `/v1/telemetry` | validate → fold → `202 {ok:true}`. Any failure is `400` (or `413`) with a fixed reason code |
| `GET` | `/v1/health` | `200 {ok:true}` |
| `GET` | `/v1/stats` | aggregate figures, k-anonymity applied |
| anything else | | `404`, and non-POST to `/v1/telemetry` is `405` |

## The four design constraints

**1. It stores no identifier.** There is no install id, no cookie, no fingerprint, and no IP
column. A submission is folded into a `(day, platform, node major, sorted agent set)` bucket on
arrival and its individual shape ceases to exist. This is stronger than a retention policy: you
cannot deanonymise a database whose rows were never written, and it does not depend on anyone
remembering to run a deletion job.

**2. Rate limiting must not become tracking.** A limiter has to tell submitters apart, which is
precisely the capability the service otherwise refuses to have. So the limiter keys on a salted
hash of the remote address, held **in memory only**, with a salt generated fresh at startup and
never persisted. Two runs of the service cannot correlate the same submitter. Nothing about the
limiter reaches disk or a log line.

**3. Logs carry reason codes, never content.** A log line is method, path, status, and one fixed
code from usewarden's own vocabulary. No body, no address, no header.

**4. Nothing the client says is trusted — including usewarden's own client.** The server
re-derives every guarantee `docs/TELEMETRY.md` makes rather than assuming the sender honoured it:

- exactly the documented keys, never "at least" — an unknown key is a rejection, not an ignored
  extra;
- every string re-checked by a content gate independent of the schema, so adding a field without
  thinking cannot open a channel;
- **the counts must be arithmetically possible.** A payload claiming more blocked actions than
  inspected events is refused as `inconsistent_counts`. That is the same inflation defect
  usewarden fixed in its own client (`docs/METRICS.md` §1) — a server that accepts impossible
  numbers will eventually publish them;
- the body cap is enforced *while reading*, not after buffering. A cap checked after the fact is
  not a cap.

## Cost ceilings — the bill is the operator's, not the user's

Every other limit in this service protects the submitter's privacy. These two protect whoever is
paying for the box, and they are the controls that decide whether this can ever be deployed at
all. An open ingest endpoint with no global ceiling is an invitation to convert somebody else's
spare bandwidth into your invoice.

| Control | Default | What it stops |
|---|---|---|
| Per-submitter rate limit | 60 / minute, per salted-hash key | accidents and single-source floods |
| **Global daily ingest ceiling** | **20,000 accepted submissions / UTC day** | **the bill** |

**The per-submitter limit is not sufficient on its own, and it is important to say why.** It keys
on a salted hash of the remote address and is deliberately amnesiac — the salt is regenerated per
process and never persisted, because a limiter that remembers submitters across restarts is a
tracking system. That design is right for privacy and it means the limit is trivially evaded by
anyone with a handful of addresses. The global ceiling is the one that bounds spend.

Past the ceiling the service returns **503 and folds nothing**. It does not queue, retry, or
buffer, because a queue is just a slower way to spend the same money. The client is built for
exactly this — 2-second timeout, zero retries, fire-and-forget — so a 503 is discarded silently
and the user never notices. The rejection is counted under `daily_ceiling_reached`, so an operator
sees it immediately in `/v1/stats`.

The ceiling is checked **before the per-submitter limit and before a single byte of body is
read.** A ceiling checked after the work is not a ceiling on the work.

### Worst-case monthly cost

Assumptions, all conservative and all stated so you can redo the arithmetic with your own:

- one submission per install per day (the client has no scheduler; this is the plausible ceiling
  of a daily-usage pattern, not a measurement);
- request ~1.2 KB up, ~40 B down, plus TLS and TCP overhead — call it **4 KB of billable traffic
  per submission** round-trip;
- storage is aggregate-only, so it grows with *bucket variety* (day × platform × node × agent
  set), **not** with install count: a few hundred rows per day at any scale, well under 10 MB/year;
- compute is a single always-on small instance; the ingest work per request is one validation and
  one SQLite upsert, microseconds each.

| Installs | Submissions/day | Traffic/month | Cost driver | Realistic monthly cost |
|---|---|---|---|---|
| 100 | 100 | ~12 MB | the instance | **~$5** — the box, whatever else happens |
| 1,000 | 1,000 | ~120 MB | the instance | **~$5** |
| 10,000 | 10,000 | ~1.2 GB | the instance | **~$5–7** |
| **ceiling reached** | **20,000/day** | **~2.4 GB/month** | the instance | **~$5–10, and it cannot go higher** |

The honest summary: **at every plausible scale this service costs the price of the smallest
instance you can rent, and the ceiling exists so that a hostile or broken client cannot change
that.** The ceiling admits 2× the expected volume at 10,000 installs, which is headroom for a
genuine growth spike without an operator waking up to a bill.

If those numbers ever stop holding — a much larger install base, or a decision to submit more than
once a day — raise `DAILY_INGEST_CEILING` deliberately and update this table in the same commit.
The number and its justification should never be more than one edit apart.

## k-anonymity

`/v1/stats` drops any bucket with fewer than 5 submissions rather than rounding it, because a
bucket of one is a description of one machine. The number of suppressed buckets is published
alongside, so the suppression is visible rather than silent.

Rejection reason codes are *not* suppressed: they are usewarden's own fixed vocabulary, never
user data, and a rejection wave is exactly what an operator needs to see immediately.

## Running it locally

```bash
npm run build
node --input-type=module -e "
  import { startService } from './dist/service/src/server.js';
  const h = await startService(8787, { log: console.log });
  console.log(h.url);
"
```

Binds `127.0.0.1` only.

## If you ever deploy this

Nothing below has been done. In roughly this order:

1. Decide whether you want it at all. Usewarden's trust posture is a feature, and "we run no
   telemetry endpoint" is a stronger sentence than any privacy policy.
2. Terminate TLS in front of it. The client refuses a non-`https://` endpoint, but this process
   speaks plain HTTP and binds loopback — it expects a reverse proxy.
3. Decide retention for the aggregate tables. There is no per-install data to expire, but bucket
   history still grows.
4. Publish the endpoint's address and this document together, so the payload schema and the
   server's rejection rules are both auditable by the people submitting.
5. Only then set `USEWARDEN_TELEMETRY_ENDPOINT` in anything, and never as a default. A default
   endpoint would make opt-in the only thing standing between a user and a network call, which
   is one control too few for a security tool.
