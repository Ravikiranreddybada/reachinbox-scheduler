# Architecture and engineering decisions

This document records the guarantees ReachInbox Scheduler makes, the failure modes it accepts, and the path from the assignment-sized deployment to a production service.

## Design goals

1. Never lose an accepted schedule because an API or worker restarts.
2. Make client retries safe and detect accidental idempotency-key reuse.
3. Coordinate pacing and quotas across horizontally scaled workers.
4. Keep business state recoverable without treating Redis or Elasticsearch as authoritative.
5. Isolate every user query and integration by tenant identity.

## Source of truth and projections

PostgreSQL is the source of truth for campaigns, recipients, state transitions, attempts, and provider message IDs. BullMQ is a durable execution index backed by Redis AOF. Elasticsearch is a rebuildable read projection.

The API commits a campaign and all recipient rows in one database transaction before it publishes BullMQ jobs. A reconciliation pass runs when either the API or worker starts. It restores missing jobs for `SCHEDULED` rows and returns `PROCESSING` rows with expired leases to `SCHEDULED`.

This gives the database precedence when infrastructure disagrees:

| Conflict                                  | Resolution                                            |
| ----------------------------------------- | ----------------------------------------------------- |
| PostgreSQL row exists, BullMQ job missing | Recreate the job with the email ID                    |
| BullMQ job exists, PostgreSQL row missing | Worker treats it as a no-op                           |
| Elasticsearch document missing or stale   | Delivery continues; rebuild the index from PostgreSQL |
| `PROCESSING` lease expires                | Return the row to `SCHEDULED` and requeue             |

## Idempotency contract

The client generates one idempotency key when the compose form opens and reuses it until that submission succeeds or is abandoned. The server stores the key with a SHA-256 fingerprint of a canonical payload.

- Same key and same payload: return the original campaign with `replayed: true`.
- Same key and different payload: return HTTP `409`.
- Concurrent identical requests: the database unique constraint selects one winner; the loser reloads the committed campaign.
- Each recipient also receives a stable derived idempotency key and uses its email ID as the BullMQ job ID.

This prevents duplicates caused by browser retries, reverse-proxy retries, and concurrent submissions. It does not claim exactly-once SMTP delivery. SMTP has no idempotency token, so a process can crash after the provider accepts a message and before PostgreSQL records `SENT`. The provider message ID and `X-ReachInbox-Email-Id` header make that rare ambiguity observable.

## Rate limiting and fairness

One Redis Lua script checks and increments three UTC-hour counters atomically:

- sender counter: tenant + sender + hour;
- campaign counter: tenant + campaign + hour;
- global counter: tenant + hour.

No worker can consume one counter without the others. When any limit is full, BullMQ moves the job to the next exact UTC hour boundary. A Redis `SET NX` key emits at most one Slack alert for each tenant, sender, scope, and window. The effective cap is the minimum of the configured campaign, sender, and tenant limits.

BullMQ's limiter enforces the configured minimum spacing across worker replicas. Worker concurrency controls in-flight SMTP work independently. This separates throughput from quota policy.

## Delivery state machine

```text
SCHEDULED -> PROCESSING -> SENT
     ^             |
     |             +-> SCHEDULED  retryable failure
     |             +-> FAILED     attempts exhausted
     +---------------- processing lease expired

SCHEDULED -> CANCELLED
```

`SENT`, `FAILED`, and `CANCELLED` are terminal for automatic processing. A processing lease is intentionally longer than the BullMQ lock duration floor. Startup recovery only reclaims expired work.

## Failure matrix

| Failure point                      | Behavior                                                            | Data loss risk                      |
| ---------------------------------- | ------------------------------------------------------------------- | ----------------------------------- |
| Before database commit             | Request fails; client can retry with same key                       | None                                |
| After commit, before queue publish | Startup reconciliation recreates jobs                               | None                                |
| Redis restart                      | AOF restores jobs; database reconciliation fills gaps               | None for accepted schedules         |
| Worker dies before SMTP call       | BullMQ stalled-job recovery retries                                 | None                                |
| Worker dies during SMTP call       | Retry after lock/lease recovery                                     | Possible duplicate at SMTP boundary |
| Elasticsearch unavailable          | Search indexing logs failure; delivery bookkeeping continues        | Search projection only              |
| Slack unavailable                  | Quota enforcement continues; notification key is released for retry | Notification only                   |

## Horizontal scale path

The API is stateless apart from its signed session cookie and can run behind a load balancer. Worker replicas share BullMQ locks and Redis counters. PostgreSQL connection limits, Elasticsearch bulk indexing, and SMTP provider quotas become the first scale constraints.

For a larger deployment:

1. Add PgBouncer and cap each process pool.
2. Move Elasticsearch writes into a transactional outbox consumer.
3. Partition queues by provider or sender domain when one noisy tenant affects latency.
4. Add tenant-level weighted fairness and per-provider quota policies.
5. Encrypt Slack webhook URLs with a KMS-backed envelope key.
6. Export queue lag, oldest scheduled age, rate-limit hits, send latency, retry count, and lease recovery count.

## Security boundaries

- Google ID tokens are verified for the configured audience.
- OAuth state is signed and expires after ten minutes.
- Sessions use HTTP-only, same-site cookies and are secure in production.
- Every API database query includes the authenticated user ID.
- Bull Board is cross-tenant operational data and is restricted to configured operator emails.
- Logs redact cookies and authorization headers.

Production would also add CSRF tokens for state-changing cookie-authenticated requests, KMS-backed secret encryption, session key rotation, an audit log, and restrictive content security headers.

## Observability contract

The service exposes `/health/live` for process liveness and `/health` for dependency readiness. PostgreSQL and Redis determine readiness; Elasticsearch degradation is reported but does not take the write path offline. Worker events use structured names such as `email.sent`, `email.failed`, `email.stalled`, and `search.index_failed` so they can become metrics and alerts without parsing prose.
