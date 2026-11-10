import { beforeEach, describe, expect, it, vi } from 'vitest';
import { jobStateNeedsRestoration } from '../domain/jobState.js';

const mocks = vi.hoisted(() => ({
  updateMany: vi.fn(),
  findMany: vi.fn(),
  getJobState: vi.fn(),
  remove: vi.fn(),
  add: vi.fn(),
  drain: vi.fn(),
}));

vi.mock('../config/env.js', () => ({
  env: { PROCESSING_LEASE_MS: 300_000, RECONCILE_INTERVAL_MS: 300_000 },
}));
vi.mock('../lib/infra.js', () => ({
  prisma: { email: { updateMany: mocks.updateMany, findMany: mocks.findMany } },
}));
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), debug: vi.fn() } }));
vi.mock('./quotaRecovery.js', () => ({ ensureQuotaState: vi.fn() }));
vi.mock('../lib/leaderLock.js', () => ({ withLeaderLock: vi.fn() }));
vi.mock('../observability/metrics.js', () => ({ increment: vi.fn() }));
vi.mock('../queues/emailQueue.js', () => ({
  emailQueue: { getJobState: mocks.getJobState, remove: mocks.remove, add: mocks.add },
  deliveryDelay: (at: Date, now: number) => Math.max(0, at.getTime() - now),
  queueHorizon: (now: number) => new Date(now + 6 * 3_600_000),
  drainSearchOutbox: mocks.drain,
}));

import { reconcileDeliveryQueue } from './recovery.js';

describe('jobStateNeedsRestoration', () => {
  it.each(['completed', 'failed', 'unknown'])('restores a %s job for scheduled rows', (state) => {
    expect(jobStateNeedsRestoration(state)).toBe(true);
  });

  it.each(['active', 'waiting', 'delayed', 'paused', 'waiting-children', 'prioritized'])(
    'keeps a live %s job',
    (state) => {
      expect(jobStateNeedsRestoration(state)).toBe(false);
    },
  );
});

describe('reconcileDeliveryQueue', () => {
  const now = new Date('2026-11-09T10:00:00.000Z');

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.findMany.mockResolvedValue([
      { id: 'email-1', scheduledAt: new Date('2026-11-09T10:05:00.000Z') },
    ]);
    mocks.remove.mockResolvedValue(1);
    mocks.drain.mockResolvedValue(0);
  });

  it('replaces a terminal job that would otherwise strand scheduled work', async () => {
    mocks.getJobState.mockResolvedValue('failed');
    const result = await reconcileDeliveryQueue(now);

    expect(mocks.remove).toHaveBeenCalledWith('email-1');
    expect(mocks.add).toHaveBeenCalledWith(
      'deliver',
      { emailId: 'email-1' },
      { jobId: 'email-1', delay: 300_000 },
    );
    expect(result).toEqual({
      staleProcessing: 1,
      restoredJobs: 1,
      scanned: 1,
      searchOutboxDrained: 0,
    });
  });

  it('recreates a missing job without trying to remove it', async () => {
    mocks.getJobState.mockResolvedValue('unknown');
    await reconcileDeliveryQueue(now);
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.add).toHaveBeenCalledOnce();
  });

  it('leaves a live job alone', async () => {
    mocks.getJobState.mockResolvedValue('delayed');
    const result = await reconcileDeliveryQueue(now);
    expect(mocks.add).not.toHaveBeenCalled();
    expect(result.restoredJobs).toBe(0);
  });

  it('only reclaims PROCESSING rows whose lease has expired', async () => {
    mocks.getJobState.mockResolvedValue('delayed');
    await reconcileDeliveryQueue(now);
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: 'PROCESSING',
          processingStartedAt: { lt: new Date('2026-11-09T09:55:00.000Z') },
        },
      }),
    );
  });

  it('only reads rows due inside the queue horizon, never the whole table', async () => {
    mocks.getJobState.mockResolvedValue('delayed');
    await reconcileDeliveryQueue(now);
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'SCHEDULED', scheduledAt: { lte: new Date('2026-11-09T16:00:00.000Z') } },
      }),
    );
  });

  it('publishes search work that was parked in the outbox', async () => {
    mocks.getJobState.mockResolvedValue('delayed');
    mocks.drain.mockResolvedValue(7);
    const result = await reconcileDeliveryQueue(now);
    expect(result.searchOutboxDrained).toBe(7);
  });
});
