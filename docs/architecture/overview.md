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

`POST /api/emails` validates the payload, normalises and de-duplicates recipients, computes the per-recipient schedule (`scheduledAt + i × delayBetweenMs`), and commits the campaign plus every email row in one transaction. The message body is stored once on the campaign, and a plain-text preview is stored for lists; email rows carry no body. A search-outbox row per email commits in the same transaction. Only after commit does it publish BullMQ jobs (in chunks of 500) with `jobId = emailId`, so re-publishing is a no-op, and only for emails due within `ENQUEUE_HORIZON_MS` (see [ADR 0005](../adr/0005-bounded-queue-horizon.md)). Search documents are queued on the `search-sync` queue; the request never waits for Elasticsearch, and if Redis is down the outbox keeps the work ([ADR 0007](../adr/0007-search-outbox.md)).

Sender creation uses `INSERT … ON CONFLICT DO NOTHING`. Prisma's `upsert` is read-then-write and failed under concurrent requests; the integration suite found this.

## Idempotency contract

The dashboard creates one idempotency key per compose session. The server stores it with a SHA-256 hash of the canonical payload.

- Same key, same payload → `200` with the original campaign and `replayed: true`.
- Same key, different payload → `409 IDEMPOTENCY_KEY_REUSED`.
- Concurrent identical requests → the unique index `(userId, idempotencyKey)` picks one winner; the losers' inserts wait for it to commit and then return the winner's campaign.
- Each email gets a derived key `sha256(key ‖ recipient)` with a unique index.

## Delivery path

### 0. Suppression check

If the recipient is on the user's suppression list (unsubscribed, complained, bounced), the row becomes `CANCELLED` and nothing else happens: no quota, no SMTP. See [ADR 0006](../adr/0006-suppression-and-bounces.md).

### 1. Receipt check

If `ri:receipt:{emailId}` exists, SMTP already accepted this email. The worker only writes `SENT` and stops. This is what makes a PostgreSQL failure after a send safe.

### 2. Slot reservation (pacing + quotas in one atomic step)

A Lua script computes `slot = max(now, lastSlot[sender] + MIN_SEND_INTERVAL_MS)` and checks four sliding one-hour quotas (sorted sets of send times): sender, campaign, tenant, global. If all have room, it adds the email ID to all four and stores the slot; otherwise it returns the time the oldest blocking send leaves the window and the scope that is full.

Why reserve instead of check-and-retry: with 5,000 emails due at once for one sender, check-and-retry wakes every job every interval (O(n²) Redis calls). A reservation gives each job its exact slot in one call; the job sleeps in BullMQ until then and sends without asking again.

- Quotas are charged at the slot, not the request time, and the window slides, so no 60-minute span exceeds a cap (also across a clock-hour boundary). Cancelled emails and known SMTP failures release their entry; a re-reserve of the same email ID never double-charges.
- If Redis loses the quota sets, `ensureQuotaState` rebuilds them from emails sent in the last hour in PostgreSQL (at worker start and on every reconcile tick).
- Reservations look ahead at most 15 minutes. A job further back in line is deferred to the horizon edge without reserving. This bounds how far a cancelled campaign can push the next one.
- All keys are declared in `KEYS`. The tenant keys share a `{tenantId}` hash tag; the global key does not, so the script assumes one Redis node (the local demo).
- A full window delays the job until it opens, plus up to 60 s of jitter, so thousands of deferred jobs do not wake in the same millisecond. One Slack alert per tenant, scope, and hour is sent through a `SET NX` gate, outside the job's critical path and with a 5 s timeout.

### 3. Start guard

A reservation spaces permissions. BullMQ timers can still run a late job right next to an on-time one. A second, tiny Lua check makes the real send starts of one sender at least `MIN_SEND_INTERVAL_MS` apart. The load test caught this: without it, two sends of one sender sometimes started in the same millisecond.

### 4. Claim

`UPDATE email SET status = 'PROCESSING' … WHERE id = $1 AND (status = 'SCHEDULED' OR (status = 'PROCESSING' AND processingStartedAt < now − lease))`. PostgreSQL row locking lets exactly one concurrent statement match. A loser whose row has a live lease delays itself until the lease ends.

### 5. Send and record

SMTP send with a stable `Message-ID: <emailId@reachinbox.local>`, through the sender's own SMTP login when it has one (otherwise the shared account), with an unsubscribe link and `List-Unsubscribe` headers. Attachment bytes come from a per-worker LRU cache. Then the receipt goes to Redis, then `SENT` to PostgreSQL, then a status event to Redis pub/sub and a search-sync job. On a temporary SMTP error the row returns to `SCHEDULED` and BullMQ retries with exponential backoff (5 attempts), after which it becomes `FAILED`. A retry passes admission again. A permanent error (SMTP 5xx) fails at once with no retry; 550/551/553/554 also suppress the address.

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

At API and worker startup and every `RECONCILE_INTERVAL_MS` in both the API and the worker, one process (Redis leader lock with a fencing token) runs:

1. `PROCESSING` rows with an expired lease → `SCHEDULED`.
2. Every `SCHEDULED` row due within the queue horizon must own a live job (waiting, delayed, active, prioritized). A missing, completed, or failed job is recreated with the same ID. States are fetched in batches of 50. Rows beyond the horizon are not read; they are queued when they come into range.
3. Search-sync work parked in the outbox is published and removed.

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
| Redis down when scheduling              | Rows commit; index work waits in the outbox; reconciler drains it | Search late, nothing lost                                                          |
| Browser loses the live stream           | Reconnect sends `Last-Event-ID`; missed events replay             | None (a `resync` event covers a trimmed log)                                       |
| Slack down                              | Alert key released for a later retry; delivery continues          | Alert only                                                                         |
| Two workers pick one email              | CAS claim lets one proceed                                        | None                                                                               |

## Search projection

Index `emails-v2` behind alias `emails`. Recipient uses a pattern analyzer that splits addresses on `@ . _ + -`, plus `keyword` and `search_as_you_type` sub-fields; subject has prefix search; body has full text. Queries filter by `userId` (a filter, so it cannot be outscored), boost exact recipient matches, and return a highlighted body fragment. Highlights use control characters instead of HTML, and the dashboard renders them as text nodes, so indexed user content can never inject markup.

Writes are state-based: the sync job loads the current row and indexes it with `version = updatedAt` and `version_type = external_gte`. An older write arriving late is rejected by Elasticsearch, so concurrent updates cannot leave a stale status. A mapping change ships as `emails-v3`, `pnpm reindex`, alias swap.

## Horizontal scale

- **API**: stateless. Sessions are signed cookies; logout writes the token ID to a Redis deny-list. HTTP rate limits count in Redis, so they hold across replicas. SSE uses one Redis subscriber per process; every event is also kept in a capped per-user Redis stream (500 events, 1 h), and a reconnecting browser's `Last-Event-ID` replays what it missed.
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
- Slack webhook URL, token and per-sender SMTP passwords are encrypted with AES-256-GCM (`enc:v1:` prefix, random IV, authenticated). `DATA_ENCRYPTION_KEY` is required (no derived fallback). Rotate by moving the old key to `DATA_ENCRYPTION_KEY_PREVIOUS` and running `pnpm rotate-secrets`.
- Elasticsearch runs with security on in docker-compose; the API signs in as `elastic`. Disconnect revokes the token at Slack and always removes the local record.
- Bull Board is restricted to operator emails; `/metrics` can require a bearer token.
- Logs redact cookies, authorization headers, webhook URLs, and tokens.

## Observability

- Structured JSON logs (pino) with stable event names (`email.sent`, `quota.exhausted`, `recovery.completed`, …) and an `X-Request-Id` on every response.
- `/health/live` (process) and `/health` (PostgreSQL, Redis, Elasticsearch, each with latency; search failure is "degraded", not "down").
- `/metrics` (Prometheus): jobs per queue and state, oldest ready job age, SSE connections, and fleet-wide counters for sends, failures, retries, cancellations, quota deferrals by scope, pacing deferrals, prevented duplicates, lease reclaims, restored jobs, and send lag.
- Suggested alerts: oldest ready job age > 60 s; `emails_failed_total` rate; `duplicate_sends_prevented_total` > 0 (investigate the database); `jobs_restored_total` > 0 outside deploys.
