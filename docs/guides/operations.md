# Operations guide

## Endpoints

| URL             | Use                                                          |
| --------------- | ------------------------------------------------------------ |
| `/health`       | Readiness. Dependency latencies (PostgreSQL, Redis, search). |
| `/health/live`  | Liveness. Process only.                                      |
| `/metrics`      | Prometheus. Bearer `METRICS_TOKEN` if set.                   |
| `/admin/queues` | Bull Board. Only emails in `BULL_BOARD_ADMIN_EMAILS`.        |

## Metrics to alert on

- Oldest-job age (queue is stuck or workers are down).
- Queue depth growth.
- Lease reclaims (workers crash mid-send).
- Deferrals (quota pressure, expected near hour boundaries).
- Prevented duplicates (receipt saved a resend; informational).

## Scaling

API and workers are stateless. Add replicas:

```bash
docker compose --profile app up -d --build --scale worker=3
```

Pacing and quotas hold across replicas (Redis Lua reservation). Throughput scales with sender count.

## Recovery

| Situation                  | What happens / what to do                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------- |
| Redis lost jobs            | Leader-elected reconciler re-creates them from PostgreSQL. Automatic.                              |
| Worker died mid-send       | Lease expires (`PROCESSING_LEASE_MS`), email is reclaimed.                                         |
| SMTP down                  | Worker refuses to start if credentials are wrong; sends retry with backoff, then `FAILED` after 5. |
| Failed email               | `POST /api/emails/:id/retry`.                                                                      |
| Search index stale or lost | `pnpm --filter @reachinbox/api reindex` (rebuilds from PostgreSQL).                                |
| Session must end now       | Logout writes a Redis deny-list entry. Instant.                                                    |

## Shutdown

SIGTERM triggers graceful shutdown with a deadline. In-flight sends finish or are leased back.

Why these behaviors: [architecture overview](../architecture/overview.md).
