import { Queue } from 'bullmq';
import { env } from '../config/env.js';
import { prisma, redis } from '../lib/infra.js';
import { logger } from '../lib/logger.js';

export const EMAIL_QUEUE = 'email-delivery';
export const SEARCH_SYNC_QUEUE = 'search-sync';

export interface DeliveryJobData {
  emailId: string;
  /** Send slot reserved by the delivery gate; quota is already charged for it. */
  slotAt?: number;
}

export const emailQueue = new Queue<DeliveryJobData, void, 'deliver'>(EMAIL_QUEUE, {
  connection: redis,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 7 * 24 * 3600, count: 10_000 },
    removeOnFail: { age: 30 * 24 * 3600, count: 50_000 },
  },
});

/**
 * Projection updates for Elasticsearch travel through their own queue, so a
 * slow or unavailable search cluster is retried in the background and never
 * blocks the API write path or a delivery slot.
 */
export const searchSyncQueue = new Queue<{ emailIds: string[] }, void, 'sync'>(SEARCH_SYNC_QUEUE, {
  connection: redis,
  defaultJobOptions: {
    attempts: 8,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: { age: 3600, count: 1_000 },
    removeOnFail: { age: 7 * 24 * 3600, count: 10_000 },
  },
});

const BULK_CHUNK = 500;

function chunk<T>(items: T[], size = BULK_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function deliveryDelay(scheduledAt: Date, now = Date.now()): number {
  return Math.max(0, scheduledAt.getTime() - now);
}

/** Latest send time that owns a BullMQ job right now. Later emails wait in PostgreSQL. */
export function queueHorizon(now = Date.now()): Date {
  return new Date(now + env.ENQUEUE_HORIZON_MS);
}

/**
 * The email ID is the job ID, so re-publishing the same email is a no-op.
 * Only emails inside the horizon are published; the reconciler queues the rest
 * as they come into range, which keeps Redis memory bounded.
 */
export async function enqueueDeliveries(emails: Array<{ id: string; scheduledAt: Date }>) {
  const horizon = queueHorizon().getTime();
  const due = emails.filter((email) => email.scheduledAt.getTime() <= horizon);
  for (const part of chunk(due)) {
    await emailQueue.addBulk(
      part.map((email) => ({
        name: 'deliver' as const,
        data: { emailId: email.id },
        opts: { jobId: email.id, delay: deliveryDelay(email.scheduledAt) },
      })),
    );
  }
}

/**
 * Queues a search-sync job and returns true. If Redis is unavailable, the email IDs are parked in
 * the PostgreSQL outbox instead, and the reconciler drains it later. The
 * projection can therefore be late, but it can no longer silently miss a row
 * (returns false in that case).
 */
export async function enqueueSearchSync(emailIds: string[]): Promise<boolean> {
  if (!emailIds.length || !env.SEARCH_ENABLED) return true;
  try {
    await searchSyncQueue.addBulk(
      chunk(emailIds).map((ids) => ({ name: 'sync' as const, data: { emailIds: ids } })),
    );
    return true;
  } catch (error) {
    logger.warn({ event: 'search.outbox_fallback', count: emailIds.length, err: error });
    for (const ids of chunk(emailIds, 1000)) {
      await prisma.searchOutbox.createMany({
        data: ids.map((emailId) => ({ emailId })),
        skipDuplicates: true,
      });
    }
    return false;
  }
}

/** Moves parked search-sync work into the queue. Returns how many IDs were published. */
export async function drainSearchOutbox(batch = 1000): Promise<number> {
  let drained = 0;
  if (!env.SEARCH_ENABLED) return drained;
  for (;;) {
    const rows = await prisma.searchOutbox.findMany({ orderBy: { id: 'asc' }, take: batch });
    if (!rows.length) return drained;
    await searchSyncQueue.addBulk(
      chunk(
        rows.map((row) => row.emailId),
        BULK_CHUNK,
      ).map((ids) => ({ name: 'sync' as const, data: { emailIds: ids } })),
    );
    await prisma.searchOutbox.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
    drained += rows.length;
    if (rows.length < batch) return drained;
  }
}
