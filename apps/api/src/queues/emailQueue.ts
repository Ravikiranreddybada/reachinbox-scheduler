import { Queue } from 'bullmq';
import { redis } from '../lib/infra.js';
export const EMAIL_QUEUE = 'email-delivery';
export const emailQueue = new Queue(EMAIL_QUEUE, {
  connection: redis,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: { age: 7 * 24 * 3600, count: 10000 },
    removeOnFail: { age: 30 * 24 * 3600, count: 50000 },
  },
});
export async function enqueueEmail(emailId: string, scheduledAt: Date) {
  const delay = Math.max(0, scheduledAt.getTime() - Date.now());
  return emailQueue.add('deliver', { emailId }, { jobId: emailId, delay });
}
