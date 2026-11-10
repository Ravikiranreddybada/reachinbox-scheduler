# API

Contract: [openapi.yaml](openapi.yaml). It is the source of truth. The endpoint table in the [root README](../../README.md#api) is a summary.

## Conventions

- Auth: signed session cookie from Google OAuth. Every query is scoped to the tenant (user).
- Writes need a same-origin `Origin` or Fetch-Metadata header (CSRF check).
- `POST /api/emails` is idempotent. Send an `idempotencyKey` in the body (8–128 chars). Same key + same payload → `200`, `replayed: true`. Same key + new payload → `409 IDEMPOTENCY_KEY_REUSED`. New → `202`.
- Lists use cursor pagination (`cursor`).
- Live updates: `GET /api/events` (Server-Sent Events).
- Cross-tenant access returns `404`, not `403`.

## View the contract

Paste `openapi.yaml` into any OpenAPI viewer (for example Swagger Editor).

Rule: change a route → change `openapi.yaml` in the same commit.
