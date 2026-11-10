# ADR 0002 — Reserve send slots instead of polling rate limits

Status: accepted

## Context

Requirements: a minimum delay between sends, hourly caps per sender (and per campaign and tenant), enforced across many workers, with over-quota work moved to the next hour instead of being dropped.

The first version used BullMQ's queue-wide limiter (one job per interval for the whole system) plus a check-and-increment quota script. Two problems: the limiter capped the whole system at one send per interval regardless of how many senders or workers existed, and check-and-retry pacing costs O(n²) wake-ups when many emails are due together.

## Decision

One Lua script per email reserves `slot = max(now, lastSlot + interval)` for the sender and charges the sender, campaign, tenant, and global quotas. Each quota is a Redis sorted set of send times (email ID as member), so the hourly cap is a sliding window and a cancelled or failed email can give its entry back. After a Redis wipe the sets are rebuilt from PostgreSQL. The job sleeps until its slot. Reservations look ahead at most 15 minutes. A small start guard at execution time keeps real send starts one interval apart even when timers fire late.

## Consequences

- Throughput scales with the number of senders; pacing holds per sender across replicas (verified by integration tests and the load test).
- O(1) Redis calls per email in the common case.
- A reservation whose send fails still counts towards the hour, like a provider's attempt count.
- All keys share a `{tenant}` hash tag and are declared up front, so the script runs on Redis Cluster.
