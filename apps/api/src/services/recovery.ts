import { env } from '../config/env.js';
import { jobStateNeedsRestoration } from '../domain/jobState.js';
import { prisma } from '../lib/infra.js';
import { withLeaderLock } from '../lib/leaderLock.js';
import { logger } from '../lib/logger.js';
import { increment } from '../observability/metrics.js';
import { ensureQuotaState } from './quotaRecovery.js';
import {
  deliveryDelay,
  drainSearchOutbox,
  emailQueue,
  queueHorizon,
} from '../queues/emailQueue.js';

export interface RecoverySummary {
  staleProcessing: number;
  restoredJobs: number;
  scanned: number;
  searchOutboxDrained: number;
}

const PAGE = 500;
const STATE_BATCH = 50;

/**
 * Reconciles BullMQ with PostgreSQL, which is the source of truth:
 *
 *  - PROCESSING rows with an expired lease go back to SCHEDULED and are failed
 *    as 'outcome unknown' on their next claim (never resent);
 *  - every SCHEDULED row due inside the queue horizon must have a live job
 *    (waiting, delayed, active); a missing or terminal job is recreated with the
 *    email ID as job ID. This is also how far-future emails enter the queue.
 *  - search-sync work parked in the outbox while Redis was down is published.
 *
 * Cost is bounded by the horizon: rows beyond it are not read at all (they are
 * found through the `status, scheduledAt` index only when they come into
 * range), so the scan does not grow with how far ahead people schedule.
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

  const horizon = queueHorizon(now.getTime());
  let cursor: string | undefined;
  let restoredJobs = 0;
  let scanned = 0;
  for (;;) {
    const rows = await prisma.email.findMany({
      where: { status: 'SCHEDULED', scheduledAt: { lte: horizon } },
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
  const searchOutboxDrained = await drainSearchOutbox().catch((error) => {
    logger.warn({ event: 'search.outbox_drain_failed', err: error });
    return 0;
  });
  return { staleProcessing: stale.count, restoredJobs, scanned, searchOutboxDrained };
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

/**
 * Starts the periodic reconcile. Both the API and the worker call this, so
 * recovery keeps running when only one of them is up. The leader lock makes
 * extra callers skip a round, so running it in every process is safe.
 */
export function startReconcileLoop(): () => void {
  const timer = setInterval(() => {
    void reconcileOnce().catch((error) => logger.error({ event: 'recovery.failed', err: error }));
  }, env.RECONCILE_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
