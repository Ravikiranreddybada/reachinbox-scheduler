# Five-minute demo script

## 0:00–0:40 — Frame the guarantees

Open the interactive architecture diagram. Explain that PostgreSQL is authoritative, BullMQ is the execution index, and Elasticsearch is a rebuildable projection. Call out the honest at-least-once SMTP boundary.

## 0:40–1:30 — Sign in and connect Slack

Use Google OAuth and show the authenticated name, email, and avatar. Connect Slack through the real OAuth flow. Point out that the webhook belongs to the signed-in tenant and that Bull Board is separately restricted to operator emails.

## 1:30–2:30 — Schedule a campaign

Open Compose, upload a CSV, and show the unique recipient count. Set a start time, two-second pacing, and a deliberately low sender limit. Submit once, then replay the captured request with the same idempotency key to show the original campaign is returned. Change one payload field with the same key and show the `409` conflict.

## 2:30–3:20 — Show distributed controls

Open Bull Board and show delayed jobs. Explain that one Redis Lua operation checks sender and tenant-wide limits atomically across all worker replicas. Let the low limit trigger, show the job delayed to the next UTC hour, and show the single Slack notification.

## 3:20–4:10 — Prove restart recovery

Stop the worker while jobs remain scheduled, then start it again. Show that jobs were not lost. For a deeper demonstration, remove one queued job while leaving its PostgreSQL row, restart the API or worker, and show the reconciliation summary restoring it.

## 4:10–4:40 — Search and observability

Search by recipient or subject. Show `/health`, `/health/live`, structured worker events, and the Elasticsearch reindex command. Explain that search degradation never changes delivery state.

## 4:40–5:00 — Close on tradeoffs

State the SMTP acknowledgement crash window clearly. Mention the next production steps: transactional outbox, encrypted integration secrets, weighted tenant fairness, and queue-lag/service-level alerts. End with `pnpm verify`, the clean dependency audit, and the committed database migration.
