import { env } from '../config/env.js';
import { jobStateNeedsRestoration } from '../domain/jobState.js';
import { prisma } from '../lib/infra.js';
import { emailQueue } from '../queues/emailQueue.js';

export interface RecoverySummary {
  staleProcessing: number;
  restoredJobs: number;
}

export async function reconcileDeliveryQueue(now = new Date()): Promise<RecoverySummary> {
  const leaseCutoff = new Date(now.getTime() - env.PROCESSING_LEASE_MS);
  const stale = await prisma.email.updateMany({
    where: {
      status: 'PROCESSING',
      processingStartedAt: { lt: leaseCutoff },
    },
    data: {
      status: 'SCHEDULED',
      processingStartedAt: null,
      errorMessage: 'Recovered after an expired processing lease.',
    },
  });

  let cursor: string | undefined;
  let restoredJobs = 0;
  for (;;) {
    const rows = await prisma.email.findMany({
      where: { status: 'SCHEDULED' },
      select: { id: true, scheduledAt: true },
      orderBy: { id: 'asc' },
      take: 500,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (!rows.length) break;

    for (const row of rows) {
      const existing = await emailQueue.getJob(row.id);
      const state = existing ? await existing.getState() : 'missing';
      if (existing && jobStateNeedsRestoration(state)) {
        await existing.remove();
      }
      if (!existing || jobStateNeedsRestoration(state)) {
        await emailQueue.add(
          'deliver',
          { emailId: row.id },
          { jobId: row.id, delay: Math.max(0, row.scheduledAt.getTime() - now.getTime()) },
        );
        restoredJobs += 1;
      }
    }
    cursor = rows.at(-1)?.id;
    if (rows.length < 500) break;
  }

  return { staleProcessing: stale.count, restoredJobs };
}
