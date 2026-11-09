import { DelayedError, Job, Worker } from 'bullmq';
import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { prisma, redis } from '../lib/infra.js';
import { EMAIL_QUEUE } from '../queues/emailQueue.js';
import { acquireSenderSlot } from '../services/rateLimit.js';
import { indexEmail } from '../services/search.js';

const transport = nodemailer.createTransport({
  host: env.ETHEREAL_HOST,
  port: env.ETHEREAL_PORT,
  secure: env.ETHEREAL_PORT === 465,
  auth:
    env.ETHEREAL_USER && env.ETHEREAL_PASSWORD
      ? { user: env.ETHEREAL_USER, pass: env.ETHEREAL_PASSWORD }
      : undefined,
  pool: true,
  maxConnections: env.WORKER_CONCURRENCY,
});

export async function verifyDeliveryTransport(): Promise<void> {
  if (!env.ETHEREAL_USER || !env.ETHEREAL_PASSWORD) {
    throw new Error(
      'Ethereal SMTP credentials are missing. Configure ETHEREAL_USER and ETHEREAL_PASSWORD.',
    );
  }
  await transport.verify();
}

async function updateSearch(emailId: string, context: string): Promise<void> {
  const email = await prisma.email.findUnique({ where: { id: emailId } });
  if (!email) return;
  await indexEmail(email).catch((error) =>
    console.warn({ event: 'search.index_failed', emailId, context, error }),
  );
}

async function processEmail(job: Job<{ emailId: string }, void, 'deliver'>): Promise<void> {
  const email = await prisma.email.findUnique({
    where: { id: job.data.emailId },
    include: { sender: true, campaign: true },
  });
  if (
    !email ||
    email.status === 'SENT' ||
    email.status === 'FAILED' ||
    email.status === 'CANCELLED'
  )
    return;

  const slot = await acquireSenderSlot(
    email.userId,
    email.senderId,
    email.campaignId,
    email.sender.email,
    email.campaign.hourlyLimit,
  );
  if (!slot.allowed) {
    await job.moveToDelayed(slot.nextAt, job.token!);
    throw new DelayedError();
  }

  await prisma.email.update({
    where: { id: email.id },
    data: {
      status: 'PROCESSING',
      processingStartedAt: new Date(),
      attempts: { increment: 1 },
      errorMessage: null,
    },
  });
  await updateSearch(email.id, 'processing');

  try {
    const info = await transport.sendMail({
      from: {
        name: email.sender.displayName || env.ETHEREAL_FROM_NAME,
        address: email.sender.email,
      },
      to: email.recipient,
      subject: email.subject,
      text: email.body,
      headers: { 'X-ReachInbox-Email-Id': email.id },
    });
    await prisma.email.update({
      where: { id: email.id },
      data: {
        status: 'SENT',
        sentAt: new Date(),
        processingStartedAt: null,
        providerMessageId: info.messageId,
        errorMessage: null,
      },
    });
    await updateSearch(email.id, 'sent');
    console.info({
      event: 'email.sent',
      emailId: email.id,
      messageId: info.messageId,
      previewUrl: nodemailer.getTestMessageUrl(
        info as unknown as Parameters<typeof nodemailer.getTestMessageUrl>[0],
      ),
    });
  } catch (error) {
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    const message = error instanceof Error ? error.message : 'Unknown delivery error';
    await prisma.email.update({
      where: { id: email.id },
      data: {
        status: finalAttempt ? 'FAILED' : 'SCHEDULED',
        processingStartedAt: null,
        errorMessage: message,
      },
    });
    await updateSearch(email.id, finalAttempt ? 'failed' : 'retry_scheduled');
    throw error;
  }
}

export const worker = new Worker(EMAIL_QUEUE, processEmail, {
  connection: redis,
  autorun: false,
  concurrency: env.WORKER_CONCURRENCY,
  ...(env.MIN_SEND_INTERVAL_MS > 0
    ? { limiter: { max: 1, duration: env.MIN_SEND_INTERVAL_MS } }
    : {}),
  lockDuration: Math.max(env.PROCESSING_LEASE_MS, 30_000),
});

worker.on('failed', (job, error) =>
  console.error({ event: 'email.failed', jobId: job?.id, error: error.message }),
);
worker.on('stalled', (jobId) => console.warn({ event: 'email.stalled', jobId }));
worker.on('error', (error) => console.error({ event: 'worker.error', error: error.message }));
