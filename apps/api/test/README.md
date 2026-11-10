# Test support

Shared setup for the integration suite (`vitest --project integration`).

| File                   | Role                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| `integration.setup.ts` | Global setup. Runs `prisma migrate deploy` on a fresh `it_<timestamp>` schema. Drops only that schema after. |
| `fixtures.ts`          | Builders for tenants (user + sender) and campaigns.                                                          |

## Run

```bash
docker compose up -d
pnpm test:integration
```

Isolation: own schema, Redis DB 15. Override with `TEST_DATABASE_URL`, `TEST_REDIS_URL`.

Config: [../../../vitest.config.mts](../../../vitest.config.mts). Test files sit next to the code they test.
