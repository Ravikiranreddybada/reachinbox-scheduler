# ADR 0004 — Search is a rebuildable, versioned projection

Status: accepted

## Context

Indexing inline in the API meant one Elasticsearch request per email (5,000 for a large campaign) inside the HTTP request, with default 30 s timeouts and retries. Concurrent updates from workers could also arrive out of order and leave a stale status in the index.

## Decision

- Index changes through a `search-sync` BullMQ queue with retries; bulk requests of up to 500 documents.
- Index the current PostgreSQL row (state, not events) with `updatedAt` as an external version, so Elasticsearch rejects older writes.
- Read and write through the `emails` alias over a versioned index (`emails-v2`) so mappings can change without downtime.
- Short client timeouts (5 s, one retry).

## Consequences

- The write path and delivery never wait on Elasticsearch; `/health` reports search as degraded, not down.
- Search can lag for seconds; the dashboard lists come from PostgreSQL.
- A transactional outbox would close the last gap (Redis unavailable at enqueue time); today `pnpm reindex` covers it.
