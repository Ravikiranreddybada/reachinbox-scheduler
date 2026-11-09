import { beforeEach, describe, expect, it, vi } from 'vitest';
import { jobStateNeedsRestoration } from '../domain/jobState.js';

const mocks = vi.hoisted(() => ({
  updateMany: vi.fn(),
  findMany: vi.fn(),
  getJob: vi.fn(),
  add: vi.fn(),
}));

vi.mock('../config/env.js', () => ({ env: { PROCESSING_LEASE_MS: 300_000 } }));
vi.mock('../lib/infra.js', () => ({
  prisma: { email: { updateMany: mocks.updateMany, findMany: mocks.findMany } },
}));
vi.mock('../queues/emailQueue.js', () => ({
  emailQueue: { getJob: mocks.getJob, add: mocks.add },
}));

import { reconcileDeliveryQueue } from './recovery.js';

describe('jobStateNeedsRestoration', () => {
  it.each(['completed', 'failed', 'unknown'])(
    'restores a %s job for scheduled database state',
    (state) => {
      expect(jobStateNeedsRestoration(state)).toBe(true);
    },
  );

  it.each(['active', 'waiting', 'delayed', 'paused', 'waiting-children'])(
    'keeps a live %s job',
    (state) => {
      expect(jobStateNeedsRestoration(state)).toBe(false);
    },
  );
});

describe('reconcileDeliveryQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.findMany.mockResolvedValue([
      { id: 'email-1', scheduledAt: new Date('2026-11-09T10:05:00.000Z') },
    ]);
    mocks.add.mockResolvedValue(undefined);
  });

  it('replaces a terminal BullMQ job that would otherwise strand scheduled work', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    mocks.getJob.mockResolvedValue({
      getState: vi.fn().mockResolvedValue('failed'),
      remove,
    });

    const result = await reconcileDeliveryQueue(new Date('2026-11-09T10:00:00.000Z'));

    expect(remove).toHaveBeenCalledOnce();
    expect(mocks.add).toHaveBeenCalledWith(
      'deliver',
      { emailId: 'email-1' },
      {
        jobId: 'email-1',
        delay: 300_000,
      },
    );
    expect(result).toEqual({ staleProcessing: 1, restoredJobs: 1 });
  });

  it('leaves an active job alone', async () => {
    mocks.getJob.mockResolvedValue({ getState: vi.fn().mockResolvedValue('active') });

    const result = await reconcileDeliveryQueue(new Date('2026-11-09T10:00:00.000Z'));

    expect(mocks.add).not.toHaveBeenCalled();
    expect(result).toEqual({ staleProcessing: 1, restoredJobs: 0 });
  });
});
