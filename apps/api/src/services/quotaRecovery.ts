import { prisma, redis } from '../lib/infra.js';
import { keys } from '../lib/keys.js';
import { logger } from '../lib/logger.js';
import { increment } from '../observability/metrics.js';

const HOUR_MS = 3_600_000;
const BATCH = 500;

/**
 * Rebuilds the hourly quota sets from PostgreSQL after Redis lost them.
 *
 * `quotaHydrated` lives in Redis next to the quota sets, so a flush or a
 * fresh Redis removes both together. When the marker is missing, every email
 * sent (or being sent) in the last hour is added back, so a sender cannot
 * exceed its cap just because Redis restarted empty. ZADD is idempotent, so
 * concurrent callers are safe.
 *
 * Not recovered: slots that were reserved but not yet used. Those jobs
 * re-reserve when they run, so only the few in-flight reservations of the
 * last 15 minutes are undercounted.
 */
export async function ensureQuotaState(now = Date.now()): Promise<{ rebuilt: number } | null> {
  if (await redis.exists(keys.quotaHydrated)) return null;

  const since = new Date(now - HOUR_MS);
  const rows = await prisma.email.findMany({
    where: {
      OR: [
        { status: 'SENT', sentAt: { gt: since } },
        { status: 'PROCESSING', processingStartedAt: { gt: since } },
      ],
    },
    select: {
      id: true,
      userId: true,
      senderId: true,
      campaignId: true,
      sentAt: true,
      processingStartedAt: true,
    },
  });

  for (let i = 0; i < rows.length; i += BATCH) {
    const pipeline = redis.pipeline();
    for (const row of rows.slice(i, i + BATCH)) {
      const score = (row.sentAt ?? row.processingStartedAt)!.getTime();
      pipeline.zadd(keys.senderQuota(row.userId, row.senderId), score, row.id);
      pipeline.zadd(keys.campaignQuota(row.userId, row.campaignId), score, row.id);
      pipeline.zadd(keys.tenantQuota(row.userId), score, row.id);
      pipeline.zadd(keys.globalQuota, score, row.id);
    }
    await pipeline.exec();
  }
  await redis.set(keys.quotaHydrated, String(now));
  increment('quota_rebuilds_total');
  logger.warn({ event: 'quota.rebuilt_from_postgres', rebuilt: rows.length });
  return { rebuilt: rows.length };
}
