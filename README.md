# ReachInbox Scheduler

A durable, horizontally scalable email scheduler: an Express + TypeScript API, BullMQ workers on Redis, PostgreSQL as the source of truth, Elasticsearch search, Ethereal SMTP, and a Next.js dashboard with live updates.

The design goal is simple to state and hard to get right: **an accepted email is never lost, never sent twice by the system's own doing, and never breaks a pacing or hourly limit, no matter how many API and worker replicas run.** Every one of those claims has a test that runs against real PostgreSQL and Redis.

## Highlights

| Concern               | How it is solved                                                                                                                                                                                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Durability            | Campaign and recipients commit in one transaction before any job exists. BullMQ jobs use the email ID as job ID. A leader-elected reconciler re-creates any job that Redis lost (no cron).                                                                                                                                           |
| Idempotent API        | Client key + SHA-256 of the canonical payload. Same key and payload → original result (`replayed: true`); same key, new payload → `409`. 10 concurrent identical requests create one campaign (tested).                                                                                                                              |
| No double processing  | Workers claim a row with a compare-and-set `UPDATE … WHERE status = 'SCHEDULED'`; exactly one of 25 concurrent claimers wins (tested). Expired leases are reclaimable.                                                                                                                                                               |
| Crash after SMTP send | A Redis delivery receipt is written the moment SMTP accepts. A retry finds it and only finishes bookkeeping, so a database blip cannot cause a second email. A stable `Message-ID` lets receivers drop the rare remaining duplicate.                                                                                                 |
| Pacing and quotas     | One Redis Lua script **reserves a send slot**: `slot = max(now, last + interval)`, then charges sender, campaign, tenant, and global sliding-hour quotas at that slot. O(1) Redis calls per email, no polling storms. Over-quota jobs wait until the oldest counted send leaves the hour window (with jitter) and are never dropped. |
| Scale-out             | Stateless API, any number of workers. All coordination (quotas, pacing, HTTP rate limits, session revocation, reconciliation lock, live events) lives in Redis. Keys carry a `{tenant}` hash tag, so the Lua scripts stay valid on Redis Cluster.                                                                                    |
| Search                | Versioned index behind an alias (`emails` → `emails-v2`), e-mail-aware analyzer, prefix search, fuzzy match, highlights. Writes go through a retrying `search-sync` queue using `updatedAt` as an external version, so out-of-order updates can never leave a stale status.                                                          |
| Live dashboard        | Workers publish status changes on Redis pub/sub; each API replica fans them out over Server-Sent Events.                                                                                                                                                                                                                             |
| Security              | Google OAuth (verified email only) with signed state + nonce; JWT sessions with a Redis deny-list for instant logout; Slack webhook and token encrypted with AES-256-GCM; Origin + Fetch-Metadata CSRF checks; tenant filter on every query.                                                                                         |
| Operations            | Structured pino logs with request IDs, `/health` (dependency latencies), `/health/live`, Prometheus `/metrics` (queue depth, oldest-job age, sends, deferrals, prevented duplicates, lease reclaims), Bull Board for operators, graceful shutdown with a deadline.                                                                   |

## Architecture

```mermaid
flowchart LR
  UI[Next.js dashboard] -- cookie session / JSON --> API[Express API replicas]
  UI -- Server-Sent Events --> API
  API -- 1 commit campaign + emails --> DB[(PostgreSQL · source of truth)]
  API -- 2 publish jobs due within the horizon, jobId = emailId --> Q[[BullMQ email-delivery]]
  API -- same transaction --> OB[(search outbox)]
  Q --- R[(Redis AOF)]
  W[Worker replicas] --> Q
  W -- reserve slot · Lua --> R
  W -- CAS claim / final state --> DB
  W -- skip suppressed recipients --> DB
  W -- send, own SMTP login per sender --> SMTP[Ethereal SMTP]
  W -- status events --> PS{{Redis pub/sub}} --> API
  W -- quota alert --> SLACK[Slack webhook]
  W & API --> SQ[[search-sync queue]] --> ES[(Elasticsearch projection)]
  REC[Reconciler · leader lock · API and worker] -. repairs and queues far-future emails .-> Q
  REC -. drains .-> OB
```

The life of one email:

```text
API commit ─► job delayed until scheduledAt (only if due within the horizon; else reconciler queues it later)
           ─► worker: receipt? ── yes ─► mark SENT (no resend)
                       │ no
                       ▼
              recipient suppressed? ─► CANCELLED (no quota, no SMTP)
              reserve slot (Lua: pacing + 3 hourly quotas)
                 ├─ quota full ─► delay until the oldest send leaves the 1-hour window (+jitter), Slack alert once per hour
                 ├─ slot later ─► delay until slot (quota already charged)
                 ▼
              start guard (real send starts ≥ interval apart)
              CAS claim  SCHEDULED → PROCESSING  (one winner)
              SMTP send ─► receipt in Redis ─► SENT in PostgreSQL ─► SSE + search sync
                 ├─ temporary SMTP error ─► SCHEDULED + BullMQ backoff, or FAILED after 5 attempts
                 └─ permanent 5xx ─► FAILED at once; 550/551/553/554 also suppress the address
```

### How scheduling works

1. `POST /api/emails` stores the campaign and every recipient in PostgreSQL in one transaction.
2. For each email due within `ENQUEUE_HORIZON_MS` (default 6 h) the API adds a BullMQ **delayed job** (`delay = scheduledAt - now`, `jobId = emailId`). Emails further out stay in PostgreSQL only; the reconciler queues them as they come into range. So Redis memory depends on the horizon, not on how far ahead people schedule. No cron, no polling loop for sends.
3. When the delay ends, a worker picks the job, sends through Ethereal SMTP, and marks the row `SENT` (or `FAILED` after 5 tries).
4. Sender, start time, per-email delay and hourly limit come from the compose form.

### How persistence on restart is handled

- PostgreSQL is the source of truth. Redis runs with AOF, so delayed jobs survive a Redis restart.
- Stopping the API or the worker loses nothing: jobs wait in Redis until a worker returns.
- If Redis loses jobs, the leader-elected reconciler rebuilds them from PostgreSQL (a `setInterval` with a Redis lock, not a cron lib). It reads only rows due inside the horizon (indexed on `status, scheduledAt`), so its cost does not grow with the whole backlog. The loop runs in both the API and the worker, so recovery continues if only one of them is up.
- Duplicates are blocked three ways: job ID = email ID, a compare-and-set claim in PostgreSQL, and a Redis delivery receipt written right after SMTP accepts.
- Restart proof: `kill -9` of API and worker with future emails pending; they still sent on time, once.

### How rate limiting and concurrency are implemented

- **Concurrency:** `WORKER_CONCURRENCY` jobs run in parallel per worker process. Many worker processes are allowed. A row claim has one winner, so parallel jobs are safe.
- **Delay between sends:** `MIN_SEND_INTERVAL_MS` (default 2000) per sender, enforced in Redis across all workers.
- **Hourly limits:** `MAX_EMAILS_PER_HOUR_PER_SENDER` (plus tenant and global caps) are sliding-window counters in Redis, changed by one Lua script. Not in memory.
- **Over the limit:** the job is not dropped or failed. It is delayed until the oldest counted send leaves the hour window, so order is kept as much as possible. The first hit per hour sends a Slack message. If Slack is not connected, nothing happens and nothing crashes, and the hour's alert is kept, so connecting Slack later in the same hour still alerts.
- **1000+ emails at once:** all jobs are accepted and queued. Pacing and caps spread them over time.

Read more: [documentation index](docs/README.md), [architecture and failure matrix](docs/architecture/overview.md), [decision records](docs/adr/), [OpenAPI contract](docs/api/openapi.yaml), [demo script](docs/guides/demo-script.md), [assignment checklist](docs/project/assignment-brief.md).

## Measured

`pnpm loadtest --emails 2000 --senders 20 --replicas 4 --concurrency 16 --interval 50` (four worker replicas in one process competing through Redis, in-process SMTP stub, laptop):

| Metric                                  | Result                                               |
| --------------------------------------- | ---------------------------------------------------- |
| Throughput                              | ≈ 250 emails/s (cap 400/s)                           |
| Emails attempted more than once         | 0 of 2,000                                           |
| Smallest gap between one sender's sends | 48 ms for a 50 ms interval (2 ms is timestamp noise) |

Throughput scales with the number of senders, because spacing is per sender, not global. The load test fails if any invariant breaks.

## Features done

**Backend** (scheduler, persistence, rate limiting, concurrency)

- Schedule API with idempotency; campaign and emails stored in PostgreSQL in one transaction.
- BullMQ delayed jobs on Redis (no cron); the reconciler rebuilds lost jobs after a restart.
- Several senders through Ethereal SMTP; per-sender spacing (`MIN_SEND_INTERVAL_MS`, default 2 s).
- Worker concurrency from `WORKER_CONCURRENCY`; single-winner claims, no duplicate sends.
- Hourly caps per sender, per campaign and per tenant in Redis; overflow waits for the sliding window to free up, nothing is dropped.
- Slack OAuth connect/disconnect and a live message when a limit is reached.
- Elasticsearch search over scheduled and sent emails; Bull Board at `/admin/queues`.
- Bounded Redis: only emails due within `ENQUEUE_HORIZON_MS` own a delayed job; later ones wait in PostgreSQL.
- Message body stored once per campaign (not per recipient); lists read a stored preview, never the body.
- Attachment bytes cached per worker (LRU, `ATTACHMENT_CACHE_BYTES`), so a campaign loads them once, not once per recipient.
- Own SMTP login per sender (encrypted at rest), with the shared Ethereal account as fallback.
- Unsubscribe link and `List-Unsubscribe` header in every email, a suppression list (unsubscribe, complaint, hard bounce), and a hard-bounce path (5xx fails at once, no retry, address suppressed).
- Search outbox: if Redis is down when emails are scheduled, the index work waits in PostgreSQL and is published later.
- Live events replay after a reconnect (`Last-Event-ID` and a capped Redis stream).
- Encryption key is required, with rotation (`DATA_ENCRYPTION_KEY_PREVIOUS`, `pnpm rotate-secrets`); Elasticsearch runs with security on.

**Frontend** (login, dashboard, compose, tables)

- Google login, name, email and avatar in the header, logout.
- Dashboard with Scheduled and Sent lists (loading, empty and error states, search, live updates).
- Compose: subject, rich-text body, CSV/text lead upload with address count, start time, delay between emails, hourly limit.
- Slack connect card; email detail page with star, archive, delete and retry.

## Assumptions and shortcuts

- Local demo only. It runs on localhost with Docker for PostgreSQL, Redis and Elasticsearch.
- Ethereal is a fake inbox, so no real mail leaves the machine.
- SMTP cannot be exactly-once; see the trade-offs below.
- A send request is capped at 5,000 recipients.

## Run locally

Requirements: Node.js 20+, pnpm 11 (pinned in `packageManager`; run `corepack enable` once), Docker.

### 1. Set up Ethereal and env variables

Ethereal is a fake SMTP inbox. No mail leaves your machine.

```bash
cp .env.example .env              # then edit .env
pnpm ethereal:account             # creates a free Ethereal account, prints 4 lines
```

1. Copy the printed `ETHEREAL_HOST`, `ETHEREAL_PORT`, `ETHEREAL_USER`, `ETHEREAL_PASSWORD` into `.env`.
2. Sent mail shows at <https://ethereal.email/messages> (log in with that user and password).
3. Set `SESSION_SECRET` (≥ 32 characters, e.g. `openssl rand -base64 32`) and `DATA_ENCRYPTION_KEY` (required, `openssl rand -base64 32`). Elasticsearch runs with security on: keep `ELASTICSEARCH_USERNAME=elastic` and `ELASTICSEARCH_PASSWORD=reachinbox-dev` from `.env.example`.
4. Add Google OAuth values: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. Redirect URI: `http://localhost:4000/auth/google/callback`.
5. Add Slack app values: `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`. Redirect URI: `http://localhost:4000/auth/slack/callback`.
6. Tune limits if you want: `WORKER_CONCURRENCY`, `MIN_SEND_INTERVAL_MS`, `MAX_EMAILS_PER_HOUR_*`. Full list in [Configuration](#configuration).

The worker checks the SMTP login at start. It refuses to start with wrong Ethereal values.

Optional, more than one SMTP account: run `pnpm ethereal:account` again, then attach the login to a sender with `PUT /api/senders/:id/smtp` (`{"user":"…","password":"…"}`). Senders without a login use the account in `.env`.

### 2. Run the backend (Express API, Redis, database, BullMQ worker)

```bash
docker compose up -d              # PostgreSQL, Redis (AOF), Elasticsearch
pnpm install
pnpm db:generate && pnpm db:migrate
pnpm --filter @reachinbox/api dev # Express API on :4000
pnpm worker                       # BullMQ worker, in a second terminal
```

Start more `pnpm worker` processes for more capacity. They share Redis and PostgreSQL, so no extra setup.

### 3. Run the frontend (Next.js)

```bash
pnpm --filter @reachinbox/web dev # dashboard on :3000, talks to the API on :4000
```

Open <http://localhost:3000> and sign in with Google.

Shortcut: `pnpm dev` starts the API and the frontend together. Run `pnpm worker` next to it.

Full stack in containers, with three worker replicas:

```bash
docker compose --profile app up -d --build --scale worker=3
```

Useful URLs: dashboard `http://localhost:3000`, readiness `http://localhost:4000/health`, metrics `http://localhost:4000/metrics`, Bull Board `http://localhost:4000/admin/queues` (emails in `BULL_BOARD_ADMIN_EMAILS` only). Rebuild search from PostgreSQL with `pnpm reindex`.

## Configuration

| Variable                                                                                         | Purpose                                                                                                                       |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`, `REDIS_URL`, `ELASTICSEARCH_URL`                                                 | Infrastructure endpoints                                                                                                      |
| `SESSION_SECRET`                                                                                 | ≥ 32 characters; signs sessions and OAuth state (placeholder rejected in production)                                          |
| `DATA_ENCRYPTION_KEY`, `DATA_ENCRYPTION_KEY_PREVIOUS`                                            | **Required** base64 32-byte key for secrets at rest (no fallback). Retired keys go in `_PREVIOUS`, then `pnpm rotate-secrets` |
| `ELASTICSEARCH_USERNAME`, `ELASTICSEARCH_PASSWORD`                                               | Elasticsearch login (docker-compose enables security; user `elastic`)                                                         |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`                                | Google OAuth web client (callback `http://localhost:4000/auth/google/callback`)                                               |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_REDIRECT_URI`                                   | Slack app with the `incoming-webhook` scope                                                                                   |
| `ETHEREAL_HOST`, `ETHEREAL_PORT`, `ETHEREAL_USER`, `ETHEREAL_PASSWORD`                           | SMTP; the worker verifies them at startup and refuses to start if they are wrong                                              |
| `DELIVERY_TRANSPORT`                                                                             | `smtp` (default) or `stream` (in-process stub for load tests)                                                                 |
| `WORKER_CONCURRENCY`                                                                             | Jobs in flight per worker process (1–100)                                                                                     |
| `MIN_SEND_INTERVAL_MS`                                                                           | Minimum time between two sends **from the same sender**, across all workers (default 2000)                                    |
| `MAX_EMAILS_PER_HOUR_PER_SENDER`, `MAX_EMAILS_PER_HOUR_PER_TENANT`, `MAX_EMAILS_PER_HOUR_GLOBAL` | Sliding one-hour caps per sender, per tenant, and across all tenants; a campaign may add its own lower cap                    |
| `PROCESSING_LEASE_MS`, `RECONCILE_INTERVAL_MS`                                                   | Lease after which a stuck send is reclaimed; reconciliation period                                                            |
| `ENQUEUE_HORIZON_MS`                                                                             | Only emails due within this window own a BullMQ job (default 6 h; at least 2 × `RECONCILE_INTERVAL_MS`)                       |
| `ATTACHMENT_CACHE_BYTES`                                                                         | Per-worker memory budget for cached attachment bytes (default 64 MB)                                                          |
| `API_PUBLIC_URL`                                                                                 | Base URL placed in unsubscribe links                                                                                          |
| `BULL_BOARD_ADMIN_EMAILS`, `METRICS_TOKEN`                                                       | Operator access to Bull Board; bearer token for `/metrics`                                                                    |
| `WEB_ORIGIN`, `API_PORT`, `LOG_LEVEL`                                                            | Browser origin, port, log level                                                                                               |

## API

| Method & path                                                           | Purpose                                                                       |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `POST /api/emails`                                                      | Schedule a campaign (≤ 5,000 recipients, idempotent). `202` new, `200` replay |
| `GET /api/emails?status=&campaignId=&cursor=`                           | Cursor-paginated list with previews                                           |
| `GET /api/emails/search?q=&status=`                                     | Full-text search with highlights                                              |
| `GET /api/emails/:id`, `POST /api/emails/:id/cancel`                    | Detail; cancel one scheduled email                                            |
| `POST /api/emails/:id/retry`                                            | Re-queue one failed email                                                     |
| `PATCH /api/emails/:id`, `DELETE /api/emails/:id`                       | Star / archive; delete (cancels first if still scheduled)                     |
| `POST /api/attachments`, `GET/DELETE /api/attachments/:id`              | Upload (raw body, ≤ 5 MB), download, remove an unsent attachment              |
| `GET /api/senders`, `PUT/DELETE /api/senders/:id/smtp`                  | Sender addresses; set or remove a sender's own SMTP login                     |
| `GET/POST /api/suppressions`, `DELETE /api/suppressions/:id`            | Suppression list (unsubscribe, bounce, complaint). Complaint webhook hook     |
| `GET/POST /unsubscribe/:token`                                          | Public one-click unsubscribe (GET shows a page, POST unsubscribes)            |
| `GET /api/settings`                                                     | Effective pacing and hourly limits (drives the dashboard Delivery Guard)      |
| `GET /api/campaigns`, `GET /api/campaigns/:id`                          | Campaigns with live progress by status                                        |
| `POST /api/campaigns/:id/cancel`                                        | Cancel every unclaimed email of a campaign                                    |
| `GET /api/events`                                                       | Server-Sent Events stream; replays missed events on `Last-Event-ID`           |
| `GET /auth/google`, `POST /auth/login`, `/auth/me`, `POST /auth/logout` | Google OAuth, email + password (signs up an unknown address), profile, logout |
| `GET /auth/slack`, `DELETE /auth/slack`                                 | Connect / disconnect Slack alerts                                             |
| `GET /health`, `/health/live`, `/metrics`, `/admin/queues`              | Operations                                                                    |

## Verification

```bash
pnpm verify             # format, unit tests, strict type-check (src + tests), production builds
pnpm test:integration   # needs `docker compose up -d`; uses a throwaway schema and Redis DB 15
pnpm loadtest           # throughput and invariants with several competing worker replicas
```

The integration suite proves, against real PostgreSQL and Redis: exactly-cap admission under 200 concurrent callers; per-sender spacing; next-hour deferral without dropping work; independent campaign caps; tenant-wide caps and tenant isolation; slots charged to the correct hour at an hour boundary; single-winner claims; lease reclaim; receipt-based duplicate prevention; recovery after Redis loses jobs; HTTP idempotency under 10 concurrent requests; `409` on key reuse; CSRF rejection; campaign cancel; cross-tenant `404`. CI runs it on every push next to the unit suite and container image builds.

## Trade-offs, stated plainly

- **A crash mid-send fails the email; it is never resent.** SMTP has no idempotency key. If a worker dies after claiming an email, the system cannot know if SMTP accepted it. The claim marker (`processingStartedAt`) stays in PostgreSQL, so the next attempt marks the row `FAILED` ("outcome unknown") instead of sending a possible duplicate. Cost: one email may need a manual resend. A known SMTP error still retries normally. A Redis receipt also covers a PostgreSQL blip after SMTP accepted.
- **Hourly caps are a sliding window.** Each quota is a Redis sorted set of send times, so no 60-minute span holds more than the cap, also across a clock-hour boundary. Cancelled emails and known SMTP failures give their quota back. A crash-abandoned email keeps it (it may have been sent).
- **Redis loss does not reset the caps.** If the quota marker is missing, the worker (at start) and the reconciler (every tick) rebuild the sets from emails sent in the last hour in PostgreSQL. Only slots reserved but not yet used are lost; those jobs re-reserve when they run.
- **Three scopes plus a global cap.** `MAX_EMAILS_PER_HOUR_PER_TENANT` is per workspace; `MAX_EMAILS_PER_HOUR_GLOBAL` is one counter for all tenants. The global key is not in a tenant hash tag, so it assumes a single Redis node (the local demo).
- **Pacing is per sender.** Reservations look ahead at most 15 minutes, so a cancelled campaign can delay the next campaign of the same sender by at most that much.
- **Far-future emails are not in Redis yet.** Only emails due within the horizon have a BullMQ job. An email scheduled a week out is a PostgreSQL row until the reconciler (every `RECONCILE_INTERVAL_MS`) sees it inside the window. Cost: queueing lags by up to one reconcile tick, which the horizon (≥ 2 ticks) absorbs.
- **Own SMTP logins are optional.** A sender without its own login shares the default Ethereal account. A sender with one sends through its own pooled connection. Ethereal is still a fake inbox, so this proves the wiring, not real provider limits.
- **Unsubscribe, complaint and bounce handling is basic.** Unsubscribe is a signed link; complaints arrive through `POST /api/suppressions` (a provider webhook would call it); only SMTP 550/551/553/554 count as a hard bounce. There are no asynchronous bounce emails (DSNs) because Ethereal sends none.
- **Search can lag, not lose.** Index work is written to a PostgreSQL outbox in the same transaction as the emails and published after Redis is back. Elasticsearch stays a rebuildable projection (`pnpm reindex`).
- **Event replay is bounded.** Each user keeps the last 500 events for one hour. A client that was away longer gets a `resync` event and refetches the lists.
- **Redis is the execution index, not the truth.** With AOF `everysec`, a Redis crash can lose one second of queue writes; the reconciler rebuilds those jobs from PostgreSQL.

## Project structure

```text
apps/
  api/                 Express API, BullMQ workers, Prisma      -> apps/api/README.md
    src/               application code                          -> apps/api/src/README.md
    prisma/            schema and committed migrations           -> apps/api/prisma/README.md
    scripts/           load test, Ethereal helper                -> apps/api/scripts/README.md
    test/              integration test setup and fixtures       -> apps/api/test/README.md
  web/                 Next.js dashboard (app/, components/, lib/) -> apps/web/README.md
docs/                  all documentation                         -> docs/README.md
  architecture/        guarantees, failure matrix, diagrams
  adr/                 decision records
  api/                 OpenAPI contract
  guides/              demo script, local development, operations
  project/             assignment brief
docker-compose.yml     PostgreSQL, Redis, Elasticsearch (+ app profile)
```
