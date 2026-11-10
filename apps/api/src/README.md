# API source

Dependency direction: `routes` → `services` → `domain`. `domain` imports nothing from infra.

| Folder           | Role                                                                                  | Rule                           |
| ---------------- | ------------------------------------------------------------------------------------- | ------------------------------ |
| `domain/`        | Pure rules: schedule plan, rate windows, job states, claim (CAS)                      | Easy to unit test.             |
| `services/`      | Delivery gate (Redis Lua), recovery/reconciler, search, Slack alerts                  | Talks to infra.                |
| `workers/`       | BullMQ processors: email delivery, search sync                                        | One file per queue.            |
| `queues/`        | Queue definitions and job publishing                                                  | Job ID = email ID.             |
| `routes/`        | `auth`, `emails`, `campaigns`                                                         | Tenant filter on every query.  |
| `http/`          | Middleware: async handler, errors, rate limit, CSRF/security                          |                                |
| `events/`        | Redis pub/sub publisher and SSE stream                                                |                                |
| `observability/` | Metrics and Prometheus output                                                         |                                |
| `lib/`           | Auth, crypto (AES-256-GCM), Redis keys, leader lock, logger, lifecycle, infra clients | Redis keys only via `keys.ts`. |
| `config/`        | Validated environment (`env.ts`)                                                      | Fail fast on bad config.       |
| `types/`         | Express type extensions                                                               |                                |

Entry points: `server.ts` (API), `worker.ts` (workers + reconciler), `reindex.ts` (rebuild search), `app.ts` (app factory).

Tests live next to code: `*.test.ts` unit, `*.int.test.ts` integration (see [../test](../test/README.md)).
