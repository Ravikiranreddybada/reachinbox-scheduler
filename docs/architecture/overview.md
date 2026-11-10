# Architecture and engineering decisions

This document records what ReachInbox Scheduler guarantees, how each guarantee is enforced, which failures it accepts, and how it grows from one laptop to a production fleet. Short decision records live in [adr/](../adr/).

## Guarantees

1. An accepted schedule is never lost, whichever process or store restarts.
2. A client retry never creates a second campaign; reusing a key for different content is rejected.
3. Only one worker processes an email at a time, and a database failure after a send does not cause a resend.
4. Pacing and hourly quotas hold across any number of worker replicas.
5. Every read and write is scoped to the authenticated tenant.

## Sources of truth

| Store         | Role                                                                    | If it is lost or wrong                             |
| ------------- | ----------------------------------------------------------------------- | -------------------------------------------------- |
| PostgreSQL    | Campaigns, emails, state, attempts                                      | Authoritative; backed up                           |
| Redis/BullMQ  | Execution index: delayed jobs, quotas, pacing, receipts, locks, pub/sub | Reconciler rebuilds jobs from PostgreSQL           |
| Elasticsearch | Search projection                                                       | `pnpm reindex` rebuilds it; delivery is unaffected |

## Write path

`POST /api/emails` validates the payload, normalises and de-duplicates recipients, computes the per-recipient schedule (`scheduledAt + i × delayBetweenMs`), and commits the campaign plus every email row in one transaction. Only after commit does it publish BullMQ jobs (in chunks of 500) with `jobId = emailId`, so re-publishing is a no-op. Search documents are queued on the `search-sync` queue; the request never waits for Elasticsearch.

Sender creation uses `INSERT … ON CONFLICT DO NOTHING`. Prisma's `upsert` is read-then-write and failed under concurrent requests; the integration suite found this.

## Idempotency contract

The dashboard creates one idempotency key per compose session. The server stores it with a SHA-256 hash of the canonical payload.

- Same key, same payload → `200` with the original campaign and `replayed: true`.
- Same key, different payload → `409 IDEMPOTENCY_KEY_REUSED`.
- Concurrent identical requests → the unique index `(userId, idempotencyKey)` picks one winner; the losers' inserts wait for it to commit and then return the winner's campaign.
- Each email gets a derived key `sha256(key ‖ recipient)` with a unique index.

## Delivery path

### 1. Receipt check

If `ri:receipt:{emailId}` exists, SMTP already accepted this email. The worker only writes `SENT` and stops. This is what makes a PostgreSQL failure after a send safe.

### 2. Slot reservation (pacing + quotas in one atomic step)

A Lua script computes `slot = max(now, lastSlot[sender] + MIN_SEND_INTERVAL_MS)` and checks three counters for the UTC hour in which `slot` falls: sender, campaign, tenant. If all have room, it increments all three and stores the slot; otherwise it returns the start of the next hour and the scope that is full.

Why reserve instead of check-and-retry: with 5,000 emails due at once for one sender, check-and-retry wakes every job every interval (O(n²) Redis calls). A reservation gives each job its exact slot in one call; the job sleeps in BullMQ until then and sends without asking again.

- Quotas are charged to the hour of the slot, not the hour of the request, so an hour boundary never lets an hour exceed its cap.
- Reservations look ahead at most 15 minutes. A job further back in line is deferred to the horizon edge without reserving. This bounds how far a cancelled campaign can push the next one.
- All keys in one script share the `{tenantId}` hash tag and are declared in `KEYS` (both the current and next hour), so the script is valid on Redis Cluster.
- A full hour moves the job to the next hour plus up to 60 s of jitter, so thousands of deferred jobs do not wake in the same millisecond. One Slack alert per tenant, scope, and hour is sent through a `SET NX` gate, outside the job's critical path and with a 5 s timeout.

### 3. Start guard

A reservation spaces permissions. BullMQ timers can still run a late job right next to an on-time one. A second, tiny Lua check makes the real send starts of one sender at least `MIN_SEND_INTERVAL_MS` apart. The load test caught this: without it, two sends of one sender sometimes started in the same millisecond.

### 4. Claim

`UPDATE email SET status = 'PROCESSING' … WHERE id = $1 AND (status = 'SCHEDULED' OR (status = 'PROCESSING' AND processingStartedAt < now − lease))`. PostgreSQL row locking lets exactly one concurrent statement match. A loser whose row has a live lease delays itself until the lease ends.

### 5. Send and record

SMTP send with a stable `Message-ID: <emailId@reachinbox.local>`. Then the receipt goes to Redis, then `SENT` to PostgreSQL, then a status event to Redis pub/sub and a search-sync job. On an SMTP error the row returns to `SCHEDULED` and BullMQ retries with exponential backoff (5 attempts), after which it becomes `FAILED`. A retry passes admission again.

## State machine

```text
SCHEDULED ──claim──► PROCESSING ──► SENT
    ▲  │                  │
    │  │                  ├──► SCHEDULED   SMTP error, attempts left
    │  │                  └──► FAILED      attempts exhausted
    │  └──cancel──► CANCELLED
    └──── lease expired (reconciler or next claim)
```

`SENT`, `FAILED`, and `CANCELLED` are terminal. Cancel is a compare-and-set on `SCHEDULED`, so a claimed email cannot be reported as cancelled and then be sent.

## Reconciliation (no cron)

At API and worker startup and every `RECONCILE_INTERVAL_MS` on the API, one process (Redis leader lock with a fencing token) runs:

1. `PROCESSING` rows with an expired lease → `SCHEDULED`.
2. Every `SCHEDULED` row must own a live job (waiting, delayed, active, prioritized). A missing, completed, or failed job is recreated with the same ID. States are fetched in batches of 50.

## Failure matrix

| Failure                                 | Behaviour                                                         | Data risk                                                                          |
| --------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| API dies before commit                  | Client retries with the same key                                  | None                                                                               |
| API dies after commit, before publish   | Client retry or reconciler publishes the jobs                     | None                                                                               |
| Redis restarts                          | AOF restores jobs; reconciler fills any gap                       | None for accepted schedules                                                        |
| Worker dies before SMTP                 | BullMQ stall detection (30 s lock) re-runs the job                | None                                                                               |
| Worker dies during SMTP, before receipt | Lease expires, job re-runs                                        | Possible duplicate (window: one Redis call); receivers can de-dupe on `Message-ID` |
| PostgreSQL fails after SMTP accepted    | Retry finds the receipt and only records `SENT`                   | None                                                                               |
| Elasticsearch down                      | `search-sync` jobs retry with backoff; `/health` reports degraded | Search is stale for a while                                                        |
| Slack down                              | Alert key released for a later retry; delivery continues          | Alert only                                                                         |
| Two workers pick one email              | CAS claim lets one proceed                                        | None                                                                               |

## Search projection

Index `emails-v2` behind alias `emails`. Recipient uses a pattern analyzer that splits addresses on `@ . _ + -`, plus `keyword` and `search_as_you_type` sub-fields; subject has prefix search; body has full text. Queries filter by `userId` (a filter, so it cannot be outscored), boost exact recipient matches, and return a highlighted body fragment. Highlights use control characters instead of HTML, and the dashboard renders them as text nodes, so indexed user content can never inject markup.

Writes are state-based: the sync job loads the current row and indexes it with `version = updatedAt` and `version_type = external_gte`. An older write arriving late is rejected by Elasticsearch, so concurrent updates cannot leave a stale status. A mapping change ships as `emails-v3`, `pnpm reindex`, alias swap.

## Horizontal scale

- **API**: stateless. Sessions are signed cookies; logout writes the token ID to a Redis deny-list. HTTP rate limits count in Redis, so they hold across replicas. SSE uses one Redis subscriber per process.
- **Workers**: add replicas for capacity. Throughput ≈ `senders × 1000 / MIN_SEND_INTERVAL_MS`, bounded by quotas and SMTP. Measured: ≈ 250 emails/s with 4 replicas, 20 senders, 50 ms spacing on a laptop, with zero duplicate attempts.
- **First limits** and the plan for each:
  1. PostgreSQL connections → PgBouncer, smaller per-process pools.
  2. One noisy tenant → per-tenant queues or weighted fair scheduling.
  3. Provider quotas → per-provider policies as another key in the reservation script.
  4. Redis memory → Redis Cluster (scripts are already slot-safe), retention limits on completed jobs.

## Security

- Google ID tokens verified for audience; only verified emails sign in. OAuth state is signed, expires in 10 minutes, and is bound to a browser nonce cookie.
- Sessions: HS256 JWT with issuer, audience, expiry, and `jti`; HTTP-only, SameSite=Lax, Secure in production. Logout revokes the `jti` immediately.
- Writes: Origin must equal the dashboard; cross-site Fetch-Metadata is rejected.
- Slack webhook URL and token are encrypted with AES-256-GCM (`enc:v1:` prefix, random IV, authenticated). Disconnect revokes the token at Slack and always removes the local record.
- Bull Board is restricted to operator emails; `/metrics` can require a bearer token.
- Logs redact cookies, authorization headers, webhook URLs, and tokens.

## Observability

- Structured JSON logs (pino) with stable event names (`email.sent`, `quota.exhausted`, `recovery.completed`, …) and an `X-Request-Id` on every response.
- `/health/live` (process) and `/health` (PostgreSQL, Redis, Elasticsearch, each with latency; search failure is "degraded", not "down").
- `/metrics` (Prometheus): jobs per queue and state, oldest ready job age, SSE connections, and fleet-wide counters for sends, failures, retries, cancellations, quota deferrals by scope, pacing deferrals, prevented duplicates, lease reclaims, restored jobs, and send lag.
- Suggested alerts: oldest ready job age > 60 s; `emails_failed_total` rate; `duplicate_sends_prevented_total` > 0 (investigate the database); `jobs_restored_total` > 0 outside deploys.
