# ADR 0003 — At-least-once SMTP delivery, narrowed by claims and receipts

Status: accepted

## Context

SMTP offers no idempotency key, so exactly-once delivery to a third party cannot be guaranteed. We can control every duplicate that our own system causes.

## Decision

1. Claim each email with a compare-and-set `UPDATE`, so only one worker sends it.
2. Write a Redis receipt immediately after SMTP accepts, before updating PostgreSQL. A retry that finds the receipt only records `SENT`.
3. Send a stable `Message-ID` derived from the email ID, so receiving systems can drop a duplicate.
4. Count prevented duplicates as a metric.

## Consequences

- The only remaining duplicate window is a process crash between SMTP acceptance and one Redis `SET`.
- Database outages after a send cannot cause a second email (integration test: receipt path).
