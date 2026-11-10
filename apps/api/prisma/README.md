# Prisma

`schema.prisma` models: `User` (tenant), `Campaign`, `Sender`, `Email`, `SlackConnection`, plus the `EmailStatus` enum.

PostgreSQL is the source of truth ([ADR 0001](../../../docs/adr/0001-postgres-is-the-source-of-truth.md)).

## Migrations

| Folder                                 | Change                                                     |
| -------------------------------------- | ---------------------------------------------------------- |
| `20261028120000_initial`               | Initial schema                                             |
| `20261109090000_campaign_hourly_limit` | Per-campaign hourly cap                                    |
| `20261109120000_delivery_hardening`    | Campaign summary columns, Slack channel name, list indexes |

## Rules

- Create: `pnpm --filter @reachinbox/api prisma:migrate:dev`.
- Apply: `pnpm db:migrate` (`migrate deploy`; same command in prod and tests).
- Never edit a migration that is committed. Add a new one.
- Commit `migration.sql` with the schema change.
