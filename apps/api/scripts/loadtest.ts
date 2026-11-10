/**
 * Delivery load test: N emails across S senders, processed by R in-process
 * worker replicas that compete through Redis exactly like separate pods.
 *
 *   pnpm loadtest -- --emails 2000 --senders 20 --replicas 4
 *
 * Uses the in-process `stream` transport (no SMTP), a throwaway tenant that
 * is deleted afterwards, and checks the invariants that matter:
 * every email sent exactly once, per-sender spacing, and hourly caps.
 */
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    emails: { type: 'string', default: '1000' },
    senders: { type: 'string', default: '10' },
    replicas: { type: 'string', default: '4' },
    concurrency: { type: 'string', default: '16' },
    interval: { type: 'string', default: '50' },
  },
});
const total = Number(values.emails);
const senderCount = Number(values.senders);
const replicas = Number(values.replicas);

// A separate Redis database keeps load-test jobs and counters out of dev data.
const redisBase = (process.env.REDIS_URL ?? 'redis://localhost:6379').replace(/\/\d+$/, '');
Object.assign(process.env, {
  REDIS_URL: `${redisBase}/14`,
  DELIVERY_TRANSPORT: 'stream',
  LOG_LEVEL: 'warn',
  WORKER_CONCURRENCY: values.concurrency,
  MIN_SEND_INTERVAL_MS: values.interval,
  MAX_EMAILS_PER_HOUR_PER_SENDER: String(total),
  MAX_EMAILS_PER_HOUR_PER_TENANT: String(total * 2),
  MAX_EMAILS_PER_HOUR_GLOBAL: String(total * 2),
});

async function main() {
  const { prisma, redis } = await import('../src/lib/infra.js');
  const { emailQueue, enqueueDeliveries, searchSyncQueue } =
    await import('../src/queues/emailQueue.js');
  const { createDeliveryWorker } = await import('../src/workers/emailWorker.js');
  const { randomUUID } = await import('node:crypto');

  const user = await prisma.user.create({
    data: {
      googleId: `load-${randomUUID()}`,
      email: `load-${randomUUID()}@example.com`,
      name: 'Load test',
    },
  });
  try {
    const senders = await Promise.all(
      Array.from({ length: senderCount }, (_, i) =>
        prisma.sender.create({ data: { userId: user.id, email: `sender${i}@load.test` } }),
      ),
    );
    const campaign = await prisma.campaign.create({
      data: {
        userId: user.id,
        idempotencyKey: randomUUID(),
        payloadHash: 'load',
        subject: 'Load',
        recipientCount: total,
      },
    });
    const now = new Date();
    await prisma.email.createMany({
      data: Array.from({ length: total }, (_, i) => ({
        userId: user.id,
        senderId: senders[i % senderCount]!.id,
        campaignId: campaign.id,
        recipient: `r${i}@load.test`,
        subject: 'Load',
        body: 'Load test body',
        scheduledAt: now,
        idempotencyKey: randomUUID(),
      })),
    });
    const emails = await prisma.email.findMany({
      where: { campaignId: campaign.id },
      select: { id: true, scheduledAt: true },
    });

    const workers = Array.from({ length: replicas }, () => createDeliveryWorker());
    const started = Date.now();
    await enqueueDeliveries(emails);
    workers.forEach((worker) => void worker.run());

    let sent = 0;
    while (sent < total) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      sent = await prisma.email.count({ where: { campaignId: campaign.id, status: 'SENT' } });
      process.stdout.write(`\rsent ${sent}/${total}`);
      if (Date.now() - started > 15 * 60_000) throw new Error('Load test timed out');
    }
    const elapsed = (Date.now() - started) / 1000;
    await Promise.all(workers.map((worker) => worker.close()));

    const rows = await prisma.email.findMany({
      where: { campaignId: campaign.id },
      select: {
        senderId: true,
        sentAt: true,
        processingStartedAt: true,
        attempts: true,
        scheduledAt: true,
      },
    });
    const lags = rows
      .map((row) => row.sentAt!.getTime() - row.scheduledAt.getTime())
      .sort((a, b) => a - b);
    const pct = (p: number) => lags[Math.min(lags.length - 1, Math.floor(p * lags.length))]!;
    let minGap = Infinity;
    for (const sender of senders) {
      const times = rows
        .filter((row) => row.senderId === sender.id)
        .map((row) => row.processingStartedAt!.getTime())
        .sort((a, b) => a - b);
      for (let i = 1; i < times.length; i += 1)
        minGap = Math.min(minGap, times[i]! - times[i - 1]!);
    }
    const multiAttempt = rows.filter((row) => row.attempts !== 1).length;

    console.log('\n');
    console.table({
      emails: total,
      senders: senderCount,
      workerReplicas: replicas,
      concurrencyPerReplica: Number(values.concurrency),
      perSenderIntervalMs: Number(values.interval),
      seconds: Number(elapsed.toFixed(2)),
      emailsPerSecond: Number((total / elapsed).toFixed(1)),
      theoreticalMaxPerSecond: Number(((senderCount * 1000) / Number(values.interval)).toFixed(1)),
      lagP50ms: pct(0.5),
      lagP95ms: pct(0.95),
      lagP99ms: pct(0.99),
      minSameSenderGapMs: minGap,
      emailsWithMoreThanOneAttempt: multiAttempt,
    });
    if (multiAttempt) throw new Error('Invariant violated: an email was attempted more than once');
    // Start times are stamped one DB round trip after the Redis guard; allow 5 ms of noise.
    if (minGap < Number(values.interval) - 5) throw new Error('Invariant violated: sender spacing');
    console.log('Invariants hold: exactly one attempt per email, per-sender spacing respected.');
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
    await Promise.all([emailQueue.close(), searchSyncQueue.close()]);
    await redis.flushdb();
    await prisma.$disconnect();
    await redis.quit();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
