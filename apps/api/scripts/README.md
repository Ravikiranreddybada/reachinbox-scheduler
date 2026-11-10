# Scripts

Run from the repo root.

| Script                | Command                 | Purpose                                                                                               |
| --------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `loadtest.ts`         | `pnpm loadtest`         | N emails, S senders, R in-process worker replicas competing via Redis. Fails if any invariant breaks. |
| `ethereal-account.ts` | `pnpm ethereal:account` | Creates an Ethereal SMTP account and prints credentials for `.env`.                                   |
| `rotate-secrets.ts`   | `pnpm rotate-secrets`   | Re-encrypts stored secrets (Slack, sender SMTP passwords) after a key change.                         |

## Load test

```bash
pnpm loadtest --emails 2000 --senders 20 --replicas 4 --concurrency 16 --interval 50
```

- Uses the `stream` transport (no SMTP) and Redis DB 14. Dev data is untouched.
- Uses a throwaway tenant, deleted afterwards.
- Checks: each email sent once, per-sender spacing, hourly caps.
- Reference numbers: [root README → Measured](../../../README.md#measured).
