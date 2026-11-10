import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign, createTenant } from '../../test/fixtures.js';
import { prisma, redis } from '../lib/infra.js';
import { keys } from '../lib/keys.js';
import { emailQueue, enqueueDeliveries, searchSyncQueue } from '../queues/emailQueue.js';
import { reconcileDeliveryQueue } from '../services/recovery.js';
import { createDeliveryWorker } from './emailWorker.js';

const worker = createDeliveryWorker();

async function waitFor(check: () => Promise<boolean>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Condition not met in time');
}

beforeAll(async () => {
  await redis.flushdb();
  void worker.run();
});
beforeEach(async () => {
  await redis.flushdb();
});
afterAll(async () => {
  await worker.close();
  await Promise.all([emailQueue.close(), searchSyncQueue.close()]);
  await prisma.$disconnect();
  await redis.quit();
});

describe('delivery worker end to end (PostgreSQL + Redis + BullMQ)', () => {
  it('sends a campaign with the minimum spacing between sends of one sender', async () => {
    const { campaign, emails } = await createCampaign(await createTenant(), 3);
    await enqueueDeliveries(emails);

    await waitFor(
      async () =>
        (await prisma.email.count({ where: { campaignId: campaign.id, status: 'SENT' } })) === 3,
    );
    const sent = await prisma.email.findMany({
      where: { campaignId: campaign.id },
      orderBy: { processingStartedAt: 'asc' },
    });
    // The start guard spaces send starts; sentAt would also carry SMTP and DB latency.
    // A few ms of slack covers the DB stamp landing slightly after the Redis guard.
    const starts = sent.map((row) => row.processingStartedAt!.getTime());
    const gaps = starts.slice(1).map((start, i) => start - starts[i]!);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(985);
    expect(sent.every((row) => row.attempts === 1 && row.providerMessageId)).toBe(true);
  });

  it('keeps over-quota emails queued for the next hour instead of dropping them', async () => {
    const { campaign, emails } = await createCampaign(await createTenant(), 4, { hourlyLimit: 2 });
    await enqueueDeliveries(emails);

    await waitFor(
      async () =>
        (await prisma.email.count({ where: { campaignId: campaign.id, status: 'SENT' } })) === 2,
    );
    await waitFor(async () => {
      const states = await Promise.all(emails.map((email) => emailQueue.getJobState(email.id)));
      return states.filter((state) => state === 'delayed').length === 2;
    });
    const nextHour = Math.ceil(Date.now() / 3_600_000) * 3_600_000;
    const waiting = await prisma.email.findMany({
      where: { campaignId: campaign.id, status: 'SCHEDULED' },
    });
    expect(waiting).toHaveLength(2);
    for (const row of waiting) {
      const job = await emailQueue.getJob(row.id);
      expect(job!.timestamp + job!.delay).toBeGreaterThanOrEqual(nextHour);
    }
  });

  it('finalises from the delivery receipt instead of sending twice', async () => {
    const { emails } = await createCampaign(await createTenant(), 1);
    const email = emails[0]!;
    // Simulates: SMTP accepted the message, then the process died before PostgreSQL saved SENT.
    await redis.set(keys.deliveryReceipt(email.id), '<already-sent@reachinbox.local>');
    await enqueueDeliveries([email]);

    await waitFor(
      async () =>
        (await prisma.email.findUniqueOrThrow({ where: { id: email.id } })).status === 'SENT',
    );
    const row = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
    expect(row.providerMessageId).toBe('<already-sent@reachinbox.local>');
    expect(row.attempts).toBe(0);
  });

  it('does not resend an email whose earlier attempt crashed mid-send', async () => {
    const { emails } = await createCampaign(await createTenant(), 1);
    const email = emails[0]!;
    // A worker claimed it, then died. The reconciler put it back to SCHEDULED.
    await prisma.email.update({
      where: { id: email.id },
      data: { processingStartedAt: new Date(Date.now() - 600_000), attempts: 1 },
    });
    await enqueueDeliveries([email]);
    await waitFor(
      async () =>
        (await prisma.email.findUniqueOrThrow({ where: { id: email.id } })).status === 'FAILED',
    );
    const row = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
    expect(row.attempts).toBe(1);
    expect(row.providerMessageId).toBeNull();
  });

  it('skips a cancelled email', async () => {
    const { emails } = await createCampaign(await createTenant(), 1);
    await prisma.email.update({ where: { id: emails[0]!.id }, data: { status: 'CANCELLED' } });
    await enqueueDeliveries(emails);
    await waitFor(async () => (await emailQueue.getJobState(emails[0]!.id)) === 'completed');
    expect((await prisma.email.findUniqueOrThrow({ where: { id: emails[0]!.id } })).status).toBe(
      'CANCELLED',
    );
  });

  it('restores jobs lost from Redis (for example after a Redis wipe) from PostgreSQL', async () => {
    const future = new Date(Date.now() + 3_600_000);
    const { emails } = await createCampaign(await createTenant(), 3, { scheduledAt: future });
    // No enqueue: the queue knows nothing, as after losing Redis data.
    const summary = await reconcileDeliveryQueue();
    expect(summary.restoredJobs).toBeGreaterThanOrEqual(3);
    for (const email of emails) expect(await emailQueue.getJobState(email.id)).toBe('delayed');
  });
});
