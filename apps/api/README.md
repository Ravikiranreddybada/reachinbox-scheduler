# @reachinbox/api

Express API and BullMQ workers. Two processes, scaled separately.

| Process | Entry           | Dev           | Prod                  |
| ------- | --------------- | ------------- | --------------------- |
| API     | `src/server.ts` | `pnpm dev`    | `node dist/server.js` |
| Worker  | `src/worker.ts` | `pnpm worker` | `node dist/worker.js` |

`src/app.ts` builds the Express app (no listen), so tests can import it.

## Layout

| Path                          | Content                        |
| ----------------------------- | ------------------------------ |
| [src/](src/README.md)         | Application code               |
| [prisma/](prisma/README.md)   | Schema and migrations          |
| [scripts/](scripts/README.md) | Load test, Ethereal helper     |
| [test/](test/README.md)       | Integration setup and fixtures |
| `Dockerfile`                  | Image for API and worker       |

## Scripts

`dev`, `worker`, `reindex`, `build`, `start`, `start:worker`, `typecheck`, `loadtest`, `ethereal:account`, `rotate-secrets`, `prisma:*`. Run from the repo root with `pnpm --filter @reachinbox/api <script>`.

## Docs

[Architecture](../../docs/architecture/overview.md) · [API contract](../../docs/api/openapi.yaml) · [Development guide](../../docs/guides/development.md)
