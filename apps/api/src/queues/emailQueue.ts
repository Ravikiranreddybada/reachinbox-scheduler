import { Queue } from 'bullmq';
import { redis } from '../lib/infra.js';

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

/** The email ID is the job ID, so re-publishing the same email is a no-op. */
export async function enqueueDeliveries(emails: Array<{ id: string; scheduledAt: Date }>) {
  for (const part of chunk(emails)) {
    await emailQueue.addBulk(
      part.map((email) => ({
        name: 'deliver' as const,
        data: { emailId: email.id },
        opts: { jobId: email.id, delay: deliveryDelay(email.scheduledAt) },
      })),
    );
  }
}

export async function enqueueSearchSync(emailIds: string[]): Promise<void> {
  if (!emailIds.length) return;
  await searchSyncQueue.addBulk(
    chunk(emailIds).map((ids) => ({ name: 'sync' as const, data: { emailIds: ids } })),
  );
}
