import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { redis } from '../lib/infra.js';
import { keys } from '../lib/keys.js';
import { RESERVATION_HORIZON_MS, reserveSendSlot } from './deliveryGate.js';

// Test env: MIN_SEND_INTERVAL_MS=1000, sender cap 10/h, tenant cap 25/h.
const HOUR = 3_600_000;
const hourStart = Math.floor(Date.parse('2026-11-09T10:00:00Z') / HOUR) * HOUR;

beforeEach(async () => {
  await redis.flushdb();
});
afterAll(async () => {
  await redis.quit();
});

describe('reserveSendSlot (real Redis)', () => {
  it('admits exactly the sender cap under 200 concurrent callers and spaces every slot', async () => {
    const now = hourStart + 1_000;
    const decisions = await Promise.all(
      Array.from({ length: 200 }, () =>
        reserveSendSlot({ userId: 'u1', senderId: 's1', campaignId: 'c1', now }),
      ),
    );
    const reserved = decisions.filter((d) => d.kind === 'reserved');
    const slots = reserved.map((d) => (d.kind === 'reserved' ? d.slotAt : 0)).sort((a, b) => a - b);

    expect(reserved).toHaveLength(10);
    expect(slots).toEqual(Array.from({ length: 10 }, (_, i) => now + i * 1_000));
    expect(decisions.filter((d) => d.kind === 'quota' && d.scope === 'sender')).toHaveLength(190);
    expect(await redis.get(keys.senderQuota('u1', 's1', Math.floor(now / HOUR)))).toBe('10');
  });

  it('moves rejected work to the start of the next UTC hour', async () => {
    const now = hourStart + 1_000;
    for (let i = 0; i < 10; i += 1)
      await reserveSendSlot({ userId: 'u1', senderId: 's1', campaignId: 'c1', now });
    const decision = await reserveSendSlot({ userId: 'u1', senderId: 's1', campaignId: 'c1', now });
    expect(decision).toMatchObject({ kind: 'quota', scope: 'sender', retryAt: hourStart + HOUR });
  });

  it('enforces a campaign cap independently of other campaigns from the same sender', async () => {
    const now = hourStart + 1_000;
    const run = (campaignId: string, limit: number) =>
      reserveSendSlot({
        userId: 'u1',
        senderId: 's1',
        campaignId,
        campaignHourlyLimit: limit,
        now,
      });
    const a = [await run('a', 2), await run('a', 2), await run('a', 2)];
    const b = [await run('b', 5), await run('b', 5)];
    expect(a.map((d) => d.kind)).toEqual(['reserved', 'reserved', 'quota']);
    expect(a[2]).toMatchObject({ scope: 'campaign' });
    expect(b.map((d) => d.kind)).toEqual(['reserved', 'reserved']);
  });

  it('applies the tenant-wide cap across senders', async () => {
    const now = hourStart + 1_000;
    const decisions = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        reserveSendSlot({ userId: 'u1', senderId: `s${i % 4}`, campaignId: `c${i % 4}`, now }),
      ),
    );
    expect(decisions.filter((d) => d.kind === 'reserved')).toHaveLength(25);
    expect(decisions.some((d) => d.kind === 'quota' && d.scope === 'tenant')).toBe(true);
  });

  it('isolates tenants', async () => {
    const now = hourStart + 1_000;
    for (let i = 0; i < 10; i += 1)
      await reserveSendSlot({ userId: 'u1', senderId: 's1', campaignId: 'c', now });
    const other = await reserveSendSlot({ userId: 'u2', senderId: 's1', campaignId: 'c', now });
    expect(other.kind).toBe('reserved');
  });

  it('charges a slot that falls in the next hour to the next hour', async () => {
    const now = hourStart + HOUR - 500;
    const first = await reserveSendSlot({ userId: 'u1', senderId: 's1', campaignId: 'c', now });
    const second = await reserveSendSlot({ userId: 'u1', senderId: 's1', campaignId: 'c', now });
    expect(first).toMatchObject({ kind: 'reserved', window: hourStart / HOUR });
    expect(second).toMatchObject({
      kind: 'reserved',
      window: hourStart / HOUR + 1,
      slotAt: now + 1_000,
    });
  });

  it('defers instead of reserving beyond the look-ahead horizon', async () => {
    const now = hourStart + 1_000;
    await redis.set(keys.senderPace('u1', 's1'), String(now + RESERVATION_HORIZON_MS + 5_000));
    const decision = await reserveSendSlot({ userId: 'u1', senderId: 's1', campaignId: 'c', now });
    expect(decision).toEqual({ kind: 'defer', retryAt: now + 6_000 });
    expect(await redis.get(keys.senderQuota('u1', 's1', Math.floor(now / HOUR)))).toBeNull();
  });
});
