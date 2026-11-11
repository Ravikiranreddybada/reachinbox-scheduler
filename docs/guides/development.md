# Development guide

## Setup

Needs Node.js 20+, pnpm, Docker.

```bash
cp .env.example .env
docker compose up -d        # PostgreSQL, Redis, Elasticsearch
pnpm install
pnpm db:generate && pnpm db:migrate
pnpm dev                    # API :4000, web :3000
pnpm worker                 # separate terminal
```

Variables: [root README → Configuration](../../README.md#configuration).

## Commands

| Command                 | Does                                                |
| ----------------------- | --------------------------------------------------- |
| `pnpm test`             | Unit tests. No infra needed.                        |
| `pnpm test:integration` | Real PostgreSQL + Redis. Fresh schema, Redis DB 15. |
| `pnpm typecheck`        | Strict type-check, src and tests.                   |
| `pnpm format:check`     | Prettier.                                           |
| `pnpm verify`           | format + unit + typecheck + build. Run before a PR. |
| `pnpm loadtest`         | Throughput and invariants.                          |

## Where code goes

See [apps/api/src/README.md](../../apps/api/src/README.md). Short form: pure rules in `domain/`, Redis/SMTP/search in `services/`, HTTP in `routes/` + `http/`.

## Add an endpoint

1. Route in `apps/api/src/routes/`. Wrap handlers with `asyncHandler`. Filter by tenant.
2. Update [openapi.yaml](../api/openapi.yaml).
3. Add an `*.int.test.ts` case.

## Change the schema

1. Edit `apps/api/prisma/schema.prisma`.
2. `pnpm --filter @reachinbox/api prisma:migrate:dev` (creates a migration).
3. Commit the migration. Never edit an applied one.

## Test conventions

- `*.test.ts` = unit. `*.int.test.ts` = integration.
- A concurrency claim needs an integration test that races real callers.

## Commits

Small, one topic. Run `pnpm verify` first.
