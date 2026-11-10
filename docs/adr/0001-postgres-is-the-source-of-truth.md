# ADR 0001 — PostgreSQL is the source of truth; Redis is an execution index

Status: accepted

## Context

BullMQ keeps delayed jobs in Redis. Redis persistence (AOF `everysec`) can still lose about one second of writes, and an operator can flush it by mistake. The brief requires that scheduled emails survive restarts.

## Decision

Commit every campaign and email row to PostgreSQL before publishing any job. Use the email ID as the BullMQ job ID. A reconciler, guarded by a Redis leader lock, makes sure every `SCHEDULED` row owns a live job and reclaims `PROCESSING` rows whose lease has expired. It runs at startup and periodically; it is not a cron job and does not drive scheduling.

## Consequences

- Losing Redis loses at most pacing state and in-flight receipts, never a schedule.
- Re-publishing is always safe, so the API can retry a failed publish and the reconciler can run on any process.
- A full scan of `SCHEDULED` rows costs O(n); at large scale it should be driven by an index on `(status, scheduledAt)` and limited to rows due soon.
