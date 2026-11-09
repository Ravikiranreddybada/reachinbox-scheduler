import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ eval: vi.fn(), notify: vi.fn() }));
vi.mock('../config/env.js', () => ({
  env: { MAX_EMAILS_PER_HOUR_PER_SENDER: 200, MAX_EMAILS_PER_HOUR_GLOBAL: 5000 },
}));
vi.mock('../lib/infra.js', () => ({ redis: { eval: mocks.eval } }));
vi.mock('./notifications.js', () => ({ notifyRateLimit: mocks.notify }));

import { acquireSenderSlot } from './rateLimit.js';

describe('acquireSenderSlot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.notify.mockResolvedValue(undefined);
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-09T10:15:00Z'));
  });
  afterEach(() => vi.restoreAllMocks());

  it('checks independent campaign, sender, and tenant counters atomically', async () => {
    mocks.eval.mockResolvedValue(['allowed', 1, 1]);

    await acquireSenderSlot('tenant', 'sender', 'campaign-a', 'from@example.com', 3);
    await acquireSenderSlot('tenant', 'sender', 'campaign-b', 'from@example.com', 9);

    const first = mocks.eval.mock.calls[0];
    const second = mocks.eval.mock.calls[1];
    expect(first[1]).toBe(3);
    expect(first[2]).toBe(second[2]);
    expect(first[3]).toBe(second[3]);
    expect(first[4]).not.toBe(second[4]);
    expect(first.slice(-3)).toEqual([200, 5000, 3]);
    expect(second.slice(-3)).toEqual([200, 5000, 9]);
  });

  it('delays a capped campaign without sending duplicate notifications for another campaign', async () => {
    mocks.eval.mockResolvedValue(['campaign', 1, 1]);
    const result = await acquireSenderSlot('tenant', 'sender', 'campaign-a', 'from@example.com', 1);

    expect(result).toMatchObject({ allowed: false, scope: 'campaign' });
    expect(mocks.notify).toHaveBeenCalledWith(
      'tenant',
      'from@example.com',
      expect.any(String),
      1,
      'campaign',
      'campaign-a',
    );
  });
});
