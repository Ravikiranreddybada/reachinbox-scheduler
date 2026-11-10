import { redis } from '../lib/infra.js';
import { logger } from '../lib/logger.js';

/**
 * Fleet-wide counters kept in Redis, so the API can export what every worker
 * replica did without a push gateway. Names follow Prometheus conventions.
 */
const PREFIX = 'ri:metrics:';

export type Counter =
  | 'emails_sent_total'
  | 'emails_failed_total'
  | 'emails_retried_total'
  | 'emails_cancelled_total'
  | 'quota_deferrals_total'
  | 'pace_deferrals_total'
  | 'duplicate_sends_prevented_total'
  | 'lease_reclaims_total'
  | 'jobs_restored_total'
  | 'send_lag_ms_sum'
  | 'send_lag_ms_count';

export function increment(counter: Counter, by = 1, label?: string): void {
  const field = label ? `${counter}{scope="${label}"}` : counter;
  redis.hincrby(`${PREFIX}counters`, field, by).catch((error) => {
    logger.debug({ event: 'metrics.increment_failed', err: error });
  });
}

export async function readCounters(): Promise<Record<string, number>> {
  const raw = await redis.hgetall(`${PREFIX}counters`);
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, Number(value)]));
}
