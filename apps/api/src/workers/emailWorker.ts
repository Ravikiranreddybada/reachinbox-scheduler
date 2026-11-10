import { DelayedError, type Job, Worker } from 'bullmq';
import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { claimEmail, isTerminal } from '../domain/delivery.js';
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
import { acquireSendStart, reserveSendSlot, withJitter } from '../services/deliveryGate.js';
import { notifyQuotaReached } from '../services/notifications.js';
import { syncEmailsById } from '../services/search.js';

/**
 * A reserved slot may start this early to absorb timer jitter. It stays well
 * below the pacing interval, so it can never collapse two slots into one.
 */
const SLOT_TOLERANCE_MS = Math.min(20, Math.floor(env.MIN_SEND_INTERVAL_MS / 4));
const RECEIPT_TTL_SECONDS = 7 * 24 * 3600;

const transport =
  env.DELIVERY_TRANSPORT === 'stream'
    ? nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' })
    : nodemailer.createTransport({
        host: env.ETHEREAL_HOST,
        port: env.ETHEREAL_PORT,
        secure: env.ETHEREAL_PORT === 465,
        auth:
          env.ETHEREAL_USER && env.ETHEREAL_PASSWORD
            ? { user: env.ETHEREAL_USER, pass: env.ETHEREAL_PASSWORD }
            : undefined,
        pool: true,
        maxConnections: Math.min(env.WORKER_CONCURRENCY, 10),
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 30_000,
      });

export async function verifyDeliveryTransport(): Promise<void> {
  if (env.DELIVERY_TRANSPORT === 'stream') return;
  if (!env.ETHEREAL_USER || !env.ETHEREAL_PASSWORD) {
    throw new Error(
      'Ethereal SMTP credentials are missing. Configure ETHEREAL_USER and ETHEREAL_PASSWORD.',
    );
  }
  await transport.verify();
}

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
    include: { sender: true, campaign: { select: { hourlyLimit: true } } },
  });
  if (!email || isTerminal(email.status)) return;

  // 1. A receipt means SMTP already accepted this email: finish bookkeeping only.
  const receipt = await redis.get(keys.deliveryReceipt(email.id));
  if (receipt) {
    increment('duplicate_sends_prevented_total');
    return finalizeSent(email, receipt, false, true);
  }

  // 2. Admission: pacing and hourly quotas, reserved once per send.
  const now = Date.now();
  let slotAt = job.data.slotAt;
  if (slotAt === undefined) {
    const decision = await reserveSendSlot({
      userId: email.userId,
      senderId: email.senderId,
      campaignId: email.campaignId,
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
  if (claim.kind === 'held') {
    // Another worker holds a live lease; wait for it to finish or expire.
    return delayUntil(job, token, claim.leaseExpiresAt + 1_000);
  }

  // 4. Side effect.
  let info: { messageId: string };
  try {
    const attachments = await prisma.attachment.findMany({
      where: { campaignId: email.campaignId },
      select: { filename: true, contentType: true, data: true },
    });
    info = await transport.sendMail({
      from: {
        name: email.sender.displayName || env.ETHEREAL_FROM_NAME,
        address: email.sender.email,
      },
      to: email.recipient,
      subject: email.subject,
      html: sanitizeEmailHtml(email.body),
      text: htmlToText(email.body),
      attachments: attachments.map((file) => ({
        filename: file.filename,
        contentType: file.contentType,
        content: Buffer.from(file.data),
      })),
      messageId: `<${email.id}@reachinbox.local>`,
      headers: { 'X-ReachInbox-Email-Id': email.id, 'X-ReachInbox-Campaign-Id': email.campaignId },
    });
  } catch (error) {
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    const status = finalAttempt ? 'FAILED' : 'SCHEDULED';
    const message = error instanceof Error ? error.message.slice(0, 500) : 'Unknown delivery error';
    // A retry must pass through admission again: the failed attempt used its slot.
    await job.updateData({ emailId: email.id });
    await prisma.email.update({
      where: { id: email.id },
      data: { status, processingStartedAt: null, errorMessage: message },
    });
    increment(finalAttempt ? 'emails_failed_total' : 'emails_retried_total');
    publishEvent(email.userId, {
      type: 'email.status',
      emailId: email.id,
      campaignId: email.campaignId,
      status,
      at: new Date().toISOString(),
    });
    syncSearch(email.id);
    logger.warn({
      event: finalAttempt ? 'email.failed' : 'email.retry',
      emailId: email.id,
      err: error,
    });
    throw error;
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
