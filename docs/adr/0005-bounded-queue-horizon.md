# ADR 0005 — Redis holds only the near future (queue horizon)

Status: accepted. Refines [0001](0001-postgres-is-the-source-of-truth.md).

## Context

Every email owned a BullMQ delayed job from the moment it was scheduled. Redis memory grew with how far ahead people schedule, and the reconciler read every `SCHEDULED` row and asked Redis for its job state, every tick. Both grow with the whole backlog, not with the work that is about to run.

## Decision

- Only emails due within `ENQUEUE_HORIZON_MS` (default 6 h) get a BullMQ delayed job. Later emails are PostgreSQL rows only.
- The reconciler reads rows with `status = SCHEDULED AND scheduledAt <= now + horizon` (index `status, scheduledAt`) and creates any missing job. This is also how far-future emails enter the queue.
- The horizon must be at least twice `RECONCILE_INTERVAL_MS`, so a row always enters the queue well before it is due.
- The message body is stored once per campaign (`Campaign.body`); lists read `Campaign.preview`. Attachment bytes are cached per worker.

## Consequences

- Redis memory and reconcile cost follow the horizon, not the backlog.
- A far-future email is queued up to one reconcile tick after it comes into range; the horizon absorbs that.
- Without a running reconciler (API and worker both run it), far-future emails would not be queued. Both processes start the loop; the leader lock keeps it single.
