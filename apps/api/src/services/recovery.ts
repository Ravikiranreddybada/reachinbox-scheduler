import { env } from '../config/env.js';
import { jobStateNeedsRestoration } from '../domain/jobState.js';
import { prisma } from '../lib/infra.js';
import { withLeaderLock } from '../lib/leaderLock.js';
import { logger } from '../lib/logger.js';
import { increment } from '../observability/metrics.js';
import { ensureQuotaState } from './quotaRecovery.js';
import { deliveryDelay, emailQueue } from '../queues/emailQueue.js';

export interface RecoverySummary {
  staleProcessing: number;
  restoredJobs: number;
  scanned: number;
}

const PAGE = 500;
const STATE_BATCH = 50;

/**
 * Reconciles BullMQ with PostgreSQL, which is the source of truth:
 *
 *  - PROCESSING rows with an expired lease go back to SCHEDULED and are failed
 *    as 'outcome unknown' on their next claim (never resent);
 *  - every SCHEDULED row must have a live job (waiting, delayed, active);
 *    a missing or terminal job is recreated with the email ID as job ID.
 *
 * Runs at startup and periodically, never as a cron job, and only on one
 * process at a time thanks to the leader lock.
 */
export async function reconcileDeliveryQueue(now = new Date()): Promise<RecoverySummary> {
  const leaseCutoff = new Date(now.getTime() - env.PROCESSING_LEASE_MS);
  const stale = await prisma.email.updateMany({
    where: { status: 'PROCESSING', processingStartedAt: { lt: leaseCutoff } },
    // processingStartedAt stays set: it marks "a worker may have sent this",
    // so the next claim fails the row instead of sending a possible duplicate.
    data: {
      status: 'SCHEDULED',
      errorMessage: 'Recovered after an expired processing lease.',
    },
  });
  if (stale.count) increment('lease_reclaims_total', stale.count);

  let cursor: string | undefined;
  let restoredJobs = 0;
  let scanned = 0;
  for (;;) {
    const rows = await prisma.email.findMany({
      where: { status: 'SCHEDULED' },
      select: { id: true, scheduledAt: true },
      orderBy: { id: 'asc' },
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (!rows.length) break;
    scanned += rows.length;

    for (let i = 0; i < rows.length; i += STATE_BATCH) {
      const batch = rows.slice(i, i + STATE_BATCH);
      const states = await Promise.all(batch.map((row) => emailQueue.getJobState(row.id)));
      for (const [index, row] of batch.entries()) {
        const state = states[index]!;
        if (!jobStateNeedsRestoration(state)) continue;
        if (state !== 'unknown') await emailQueue.remove(row.id).catch(() => 0);
        await emailQueue.add(
          'deliver',
          { emailId: row.id },
          { jobId: row.id, delay: deliveryDelay(row.scheduledAt, now.getTime()) },
        );
        restoredJobs += 1;
      }
    }
    cursor = rows.at(-1)?.id;
    if (rows.length < PAGE) break;
  }
  if (restoredJobs) increment('jobs_restored_total', restoredJobs);
  return { staleProcessing: stale.count, restoredJobs, scanned };
}

/** Fleet-safe wrapper: replicas that lose the lock skip this round. */
export async function reconcileOnce(): Promise<RecoverySummary | null> {
  const outcome = await withLeaderLock('reconcile', 10 * 60_000, async () => {
    // Redis may have been wiped since the last tick: rebuild hourly quotas first.
    await ensureQuotaState().catch((error) =>
      logger.error({ event: 'quota.rebuild_failed', err: error }),
    );
    return reconcileDeliveryQueue();
  });
  if (!outcome.ran) {
    logger.debug({ event: 'recovery.skipped', reason: 'another process holds the lock' });
    return null;
  }
  logger.info({ event: 'recovery.completed', ...outcome.result });
  return outcome.result;
}
