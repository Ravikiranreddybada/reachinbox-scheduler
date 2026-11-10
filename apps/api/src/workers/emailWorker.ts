import { DelayedError, type Job, UnrecoverableError, Worker } from 'bullmq';
import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { ABANDONED_MESSAGE, claimEmail, isTerminal } from '../domain/delivery.js';
import { publishEvent } from '../events/publisher.js';
import { htmlToText, sanitizeEmailHtml } from '../lib/html.js';
import { prisma, redis } from '../lib/infra.js';
import { keys } from '../lib/keys.js';
import { logger } from '../lib/logger.js';
import { increment } from '../observability/metrics.js';
import {
  type DeliveryJobData,
  EMAIL_QUEUE,
  enqueueSearchSync,
  SEARCH_SYNC_QUEUE,
} from '../queues/emailQueue.js';
import {
  acquireSendStart,
  releaseQuota,
  reserveSendSlot,
  withJitter,
} from '../services/deliveryGate.js';
import { attachmentsForCampaign } from '../services/attachmentCache.js';
import { notifyQuotaReached } from '../services/notifications.js';
import { syncEmailsById } from '../services/search.js';
import { suppressionMessage, suppressRecipient } from '../services/suppressions.js';
import { transportFor, verifyDefaultTransport } from '../services/transports.js';
import { unsubscribeUrl } from '../lib/unsubscribe.js';

/**
 * A reserved slot may start this early to absorb timer jitter. It stays well
 * below the pacing interval, so it can never collapse two slots into one.
 */
const SLOT_TOLERANCE_MS = Math.min(20, Math.floor(env.MIN_SEND_INTERVAL_MS / 4));
const RECEIPT_TTL_SECONDS = 7 * 24 * 3600;

export const verifyDeliveryTransport = verifyDefaultTransport;

/** A permanent SMTP failure (5xx) will never succeed on retry. */
function smtpResponseCode(error: unknown): number {
  const code = (error as { responseCode?: unknown } | null)?.responseCode;
  return typeof code === 'number' ? code : 0;
}
/** Codes that mean "this recipient address is bad": the address is suppressed (a hard bounce). */
const BOUNCE_CODES = new Set([550, 551, 553, 554]);

function syncSearch(emailId: string): void {
  enqueueSearchSync([emailId]).catch((error) =>
    logger.warn({ event: 'search.enqueue_failed', emailId, err: error }),
  );
}

async function delayUntil(
  job: Job<DeliveryJobData>,
  token: string | undefined,
  at: number,
): Promise<never> {
  await job.moveToDelayed(at, token);
  throw new DelayedError();
}

/**
 * Records SENT. The Redis receipt is written first, straight after SMTP
 * accepts the message: if PostgreSQL is briefly unavailable, the BullMQ retry
 * finds the receipt and finalises the row without sending a second email.
 */
async function finalizeSent(
  email: { id: string; userId: string; campaignId: string; scheduledAt: Date },
  messageId: string,
  previewUrl: string | false,
  duplicatePrevented = false,
): Promise<void> {
  const sentAt = new Date();
  await prisma.email.update({
    where: { id: email.id },
    data: {
      status: 'SENT',
      sentAt,
      // processingStartedAt is kept as the attempt start time for audits; the
      // lease logic only looks at PROCESSING rows.
      providerMessageId: messageId,
      errorMessage: null,
    },
  });
  increment('emails_sent_total');
  increment('send_lag_ms_sum', Math.max(0, sentAt.getTime() - email.scheduledAt.getTime()));
  increment('send_lag_ms_count');
  publishEvent(email.userId, {
    type: 'email.status',
    emailId: email.id,
    campaignId: email.campaignId,
    status: 'SENT',
    at: sentAt.toISOString(),
  });
  syncSearch(email.id);
  logger.info({
    event: 'email.sent',
    emailId: email.id,
    messageId,
    previewUrl,
    duplicatePrevented,
  });
}

export async function processDelivery(
  job: Job<DeliveryJobData, void, 'deliver'>,
  token?: string,
): Promise<void> {
  const email = await prisma.email.findUnique({
    where: { id: job.data.emailId },
    include: { sender: true, campaign: { select: { hourlyLimit: true, body: true } } },
  });
  if (!email || isTerminal(email.status)) return;
  const body = email.body ?? email.campaign.body ?? '';

  // 1. A receipt means SMTP already accepted this email: finish bookkeeping only.
  const receipt = await redis.get(keys.deliveryReceipt(email.id));
  if (receipt) {
    increment('duplicate_sends_prevented_total');
    return finalizeSent(email, receipt, false, true);
  }

  // 1b. Suppressed recipients (unsubscribed, bounced, complained) are never emailed.
  const suppressed = await prisma.suppression.findUnique({
    where: { userId_email: { userId: email.userId, email: email.recipient } },
    select: { reason: true },
  });
  if (suppressed) {
    const skipped = await prisma.email.updateMany({
      where: { id: email.id, status: 'SCHEDULED' },
      data: { status: 'CANCELLED', errorMessage: suppressionMessage(suppressed.reason) },
    });
    if (skipped.count) {
      increment('emails_suppressed_total');
      publishEvent(email.userId, {
        type: 'email.status',
        emailId: email.id,
        campaignId: email.campaignId,
        status: 'CANCELLED',
        at: new Date().toISOString(),
      });
      syncSearch(email.id);
      logger.info({ event: 'email.suppressed', emailId: email.id, reason: suppressed.reason });
    }
    return;
  }

  // 2. Admission: pacing and hourly quotas, reserved once per send.
  const now = Date.now();
  let slotAt = job.data.slotAt;
  if (slotAt === undefined) {
    const decision = await reserveSendSlot({
      userId: email.userId,
      senderId: email.senderId,
      campaignId: email.campaignId,
      emailId: email.id,
      campaignHourlyLimit: email.campaign.hourlyLimit,
      now,
    });
    if (decision.kind === 'quota') {
      increment('quota_deferrals_total', 1, decision.scope);
      void notifyQuotaReached({
        userId: email.userId,
        senderEmail: email.sender.email,
        campaignId: email.campaignId,
        scope: decision.scope,
        limit: decision.limit,
        window: decision.window,
        resumesAt: decision.retryAt,
      }).catch((error) => logger.warn({ event: 'slack.quota_alert_failed', err: error }));
      logger.info({
        event: 'quota.exhausted',
        emailId: email.id,
        scope: decision.scope,
        resumesAt: new Date(decision.retryAt).toISOString(),
      });
      return delayUntil(job, token, withJitter(decision.retryAt));
    }
    if (decision.kind === 'defer') {
      increment('pace_deferrals_total');
      return delayUntil(job, token, withJitter(decision.retryAt, 5_000));
    }
    slotAt = decision.slotAt;
    await job.updateData({ ...job.data, slotAt });
  }
  if (slotAt - Date.now() > SLOT_TOLERANCE_MS) return delayUntil(job, token, slotAt);
  const wait = await acquireSendStart(email.userId, email.senderId);
  if (wait > 0) return delayUntil(job, token, Date.now() + wait);

  // 3. Claim the row with compare-and-set; only one worker can win it.
  const claim = await claimEmail(email.id, new Date(), env.PROCESSING_LEASE_MS);
  if (claim.kind === 'terminal') return;
  if (claim.kind === 'abandoned') {
    // Quota stays charged: the message may really have been sent.
    increment('emails_abandoned_total');
    publishEvent(email.userId, {
      type: 'email.status',
      emailId: email.id,
      campaignId: email.campaignId,
      status: 'FAILED',
      at: new Date().toISOString(),
    });
    syncSearch(email.id);
    logger.error({ event: 'email.abandoned', emailId: email.id, reason: ABANDONED_MESSAGE });
    return;
  }
  if (claim.kind === 'held') {
    // Another worker holds a live lease; wait for it to finish or expire.
    return delayUntil(job, token, claim.leaseExpiresAt + 1_000);
  }

  // 4. Side effect.
  let info: { messageId: string };
  try {
    const attachments = await attachmentsForCampaign(email.campaignId);
    const unsubscribe = unsubscribeUrl(email.id);
    const safeBody = sanitizeEmailHtml(body);
    info = await transportFor(email.sender).sendMail({
      from: {
        name: email.sender.displayName || env.ETHEREAL_FROM_NAME,
        address: email.sender.email,
      },
      to: email.recipient,
      subject: email.subject,
      html: `${safeBody}<p style="font-size:12px;color:#6b7280"><a href="${unsubscribe}">Unsubscribe</a></p>`,
      text: `${htmlToText(body)}\n\nUnsubscribe: ${unsubscribe}`,
      attachments,
      messageId: `<${email.id}@reachinbox.local>`,
      headers: {
        'X-ReachInbox-Email-Id': email.id,
        'X-ReachInbox-Campaign-Id': email.campaignId,
        'List-Unsubscribe': `<${unsubscribe}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
  } catch (error) {
    const code = smtpResponseCode(error);
    // 5xx is permanent: retrying cannot help, so fail now instead of burning attempts.
    const permanent = code >= 500 && code < 600;
    const finalAttempt = permanent || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    const status = finalAttempt ? 'FAILED' : 'SCHEDULED';
    const message = error instanceof Error ? error.message.slice(0, 500) : 'Unknown delivery error';
    // A retry must pass through admission again: the failed attempt used its slot.
    await job.updateData({ emailId: email.id });
    await prisma.email.update({
      where: { id: email.id },
      data: { status, processingStartedAt: null, errorMessage: message },
    });
    // The failed attempt did not send anything, so it gives its quota back.
    // A retry re-reserves with the same email ID, so there is no double charge.
    await releaseQuota([{ ...email, emailId: email.id }]).catch(() => undefined);
    increment(finalAttempt ? 'emails_failed_total' : 'emails_retried_total');
    publishEvent(email.userId, {
      type: 'email.status',
      emailId: email.id,
      campaignId: email.campaignId,
      status,
      at: new Date().toISOString(),
    });
    syncSearch(email.id);
    if (permanent && BOUNCE_CODES.has(code)) {
      // Hard bounce: never mail this address again. Cancels its other pending emails.
      await suppressRecipient(email.userId, email.recipient, 'BOUNCE', message).catch((cause) =>
        logger.warn({ event: 'suppression.bounce_failed', emailId: email.id, err: cause }),
      );
      increment('emails_bounced_total');
    }
    logger.warn({
      event: finalAttempt ? 'email.failed' : 'email.retry',
      emailId: email.id,
      err: error,
    });
    throw permanent ? new UnrecoverableError(message) : error;
  }

  // 5. Bookkeeping. Receipt first, then PostgreSQL; see finalizeSent.
  await redis.set(keys.deliveryReceipt(email.id), info.messageId, 'EX', RECEIPT_TTL_SECONDS);
  const previewUrl =
    env.DELIVERY_TRANSPORT === 'smtp'
      ? nodemailer.getTestMessageUrl(
          info as unknown as Parameters<typeof nodemailer.getTestMessageUrl>[0],
        )
      : false;
  await finalizeSent(email, info.messageId, previewUrl);
}

export function createDeliveryWorker() {
  const worker = new Worker<DeliveryJobData, void, 'deliver'>(EMAIL_QUEUE, processDelivery, {
    connection: redis,
    autorun: false,
    concurrency: env.WORKER_CONCURRENCY,
    // The lock is renewed every lockDuration/2 while a job runs, so a short
    // lock detects a crashed worker fast without limiting slow SMTP calls.
    lockDuration: 30_000,
    maxStalledCount: 2,
  });
  worker.on('stalled', (jobId) => logger.warn({ event: 'email.stalled', jobId }));
  worker.on('error', (error) => logger.error({ event: 'worker.error', err: error }));
  return worker;
}

export function createSearchSyncWorker() {
  const worker = new Worker<{ emailIds: string[] }, void, 'sync'>(
    SEARCH_SYNC_QUEUE,
    async (job) => syncEmailsById(job.data.emailIds),
    { connection: redis, autorun: false, concurrency: 2 },
  );
  worker.on('failed', (job, error) =>
    logger.warn({
      event: 'search.sync_failed',
      jobId: job?.id,
      attempts: job?.attemptsMade,
      err: error,
    }),
  );
  worker.on('error', (error) => logger.error({ event: 'search_worker.error', err: error }));
  return worker;
}
