# ADR 0007 — Search outbox

Status: accepted. Supersedes the last consequence of [0004](0004-search-is-a-versioned-projection.md).

## Context

If Redis was unavailable when emails were scheduled, the `search-sync` job was never queued and the emails were missing from the index until someone ran `pnpm reindex`.

## Decision

- Scheduling inserts one `SearchOutbox` row per email in the same transaction as the emails.
- After commit, the API queues the sync job and deletes those outbox rows. If queueing fails, `enqueueSearchSync` writes the IDs to the outbox instead of failing.
- The reconciler drains the outbox every tick: it queues the sync jobs, then deletes the rows. Publishing twice is harmless because the sync is state-based and versioned.

## Consequences

- The index can be late after a Redis outage, but it cannot silently miss scheduled emails.
- `pnpm reindex` stays as the repair for any other drift.
