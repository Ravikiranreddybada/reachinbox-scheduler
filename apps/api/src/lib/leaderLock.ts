import { randomUUID } from 'node:crypto';
import { keys } from './keys.js';
import { redis } from './infra.js';

const releaseScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

/**
 * Run `task` on at most one process across the fleet. Used so N API replicas
 * and M workers do not all scan PostgreSQL for reconciliation at once.
 * The token check on release stops a slow holder from deleting a lock that
 * already expired and was taken by another process.
 */
export async function withLeaderLock<T>(
  name: string,
  ttlMs: number,
  task: () => Promise<T>,
): Promise<{ ran: true; result: T } | { ran: false }> {
  const token = randomUUID();
  const lockKey = keys.leaderLock(name);
  const acquired = await redis.set(lockKey, token, 'PX', ttlMs, 'NX');
  if (!acquired) return { ran: false };
  try {
    return { ran: true, result: await task() };
  } finally {
    await redis.eval(releaseScript, 1, lockKey, token);
  }
}
