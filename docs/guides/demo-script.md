# Five-minute demo script

## 0:00–0:40 — Frame the guarantees

Show the README "Highlights" table. PostgreSQL is the truth, BullMQ is the execution index, Elasticsearch is a projection. State the one honest limit: SMTP is at-least-once, and the window is one Redis call.

## 0:40–1:20 — Sign in, connect Slack

Google sign-in shows name, email, avatar. Connect Slack through OAuth. Mention that the webhook URL is stored encrypted and that logout revokes the session immediately.

## 1:20–2:20 — Schedule and replay

Compose, import a CSV, show the unique count. Set a start time, 2 s delay, and an hourly limit of 3. Submit. Replay the same request with `curl` and the same idempotency key → `200 replayed: true`. Change the subject with the same key → `409 IDEMPOTENCY_KEY_REUSED`.

## 2:20–3:10 — Distributed limits, live

Start two workers (`pnpm worker` twice). Watch rows flip to Sent live in the dashboard (SSE). After 3 sends the rest stay Scheduled; Bull Board shows them delayed to the next UTC hour; one Slack message arrives. Open `/metrics` and point at `reachinbox_quota_deferrals_total{scope="campaign"}`.

## 3:10–3:50 — Crash recovery

Kill a worker with jobs pending, start it again: nothing is lost. Optional: flush the Redis queue keys and restart the API; the log shows `recovery.completed` with `restoredJobs`.

## 3:50–4:30 — Search, detail, retry

Search a partial or misspelled word (`restrt` finds "Restart demo"); matches are highlighted. Open one email: star, archive, delete. A FAILED row in Sent has a Retry button. Cancel a campaign from the API (`POST /api/campaigns/:id/cancel`), shown in Postman or curl.

## 4:30–5:00 — Proof

Run `pnpm test:integration` (73 tests in total: 36 unit and 37 integration) and show the load test table: thousands of emails over four competing replicas, zero duplicate attempts, per-sender spacing held.
