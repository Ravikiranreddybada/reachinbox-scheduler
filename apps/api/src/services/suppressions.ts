import type { SuppressionReason } from '@prisma/client';
import { publishEvent } from '../events/publisher.js';
import { prisma } from '../lib/infra.js';
import { logger } from '../lib/logger.js';
import { increment } from '../observability/metrics.js';
import { enqueueSearchSync } from '../queues/emailQueue.js';
import { releaseQuota } from './deliveryGate.js';

export const suppressionMessage = (reason: SuppressionReason) =>
  `Skipped: the recipient is on the suppression list (${reason.toLowerCase()}).`;

/**
 * Adds a recipient to the user's suppression list and cancels every email to
 * that address that no worker has claimed yet. Idempotent. The worker checks
 * the list again right before each send, so a race cannot slip a message out.
 */
export async function suppressRecipient(
  userId: string,
  recipient: string,
  reason: SuppressionReason,
  note?: string,
): Promise<{ cancelled: number }> {
  const email = recipient.trim().toLowerCase();
  await prisma.suppression.upsert({
    where: { userId_email: { userId, email } },
    create: { userId, email, reason, note },
    update: {},
  });
  const targets = await prisma.email.findMany({
    where: { userId, recipient: email, status: 'SCHEDULED' },
    select: { id: true, senderId: true, campaignId: true },
  });
  if (!targets.length) return { cancelled: 0 };
  const result = await prisma.email.updateMany({
    where: { id: { in: targets.map((row) => row.id) }, status: 'SCHEDULED' },
    data: { status: 'CANCELLED', errorMessage: suppressionMessage(reason) },
  });
  await releaseQuota(
    targets.map((row) => ({
      userId,
      senderId: row.senderId,
      campaignId: row.campaignId,
      emailId: row.id,
    })),
  ).catch(() => undefined);
  for (const row of targets) {
    publishEvent(userId, {
      type: 'email.status',
      emailId: row.id,
      campaignId: row.campaignId,
      status: 'CANCELLED',
      at: new Date().toISOString(),
    });
  }
  increment('emails_suppressed_total', result.count);
  void enqueueSearchSync(targets.map((row) => row.id)).catch(() => undefined);
  logger.info({ event: 'recipient.suppressed', userId, reason, cancelled: result.count });
  return { cancelled: result.count };
}
