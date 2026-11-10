import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { redis } from '../lib/infra.js';
import { keys } from '../lib/keys.js';
import { RESERVATION_HORIZON_MS, releaseQuota, reserveSendSlot } from './deliveryGate.js';
import { ensureQuotaState } from './quotaRecovery.js';
import { createCampaign, createTenant } from '../../test/fixtures.js';
import { prisma } from '../lib/infra.js';

// Test env: MIN_SEND_INTERVAL_MS=1000, sender cap 10/h, tenant cap 25/h, global cap 60/h.
const HOUR = 3_600_000;
let seq = 0;
const reserve = (r: Omit<Parameters<typeof reserveSendSlot>[0], 'emailId'>) =>
  reserveSendSlot({ ...r, emailId: `e${seq++}` });
const hourStart = Math.floor(Date.parse('2026-11-09T10:00:00Z') / HOUR) * HOUR;

beforeEach(async () => {
  await redis.flushdb();
});
afterAll(async () => {
  await prisma.$disconnect();
  await redis.quit();
});

describe('reserveSendSlot (real Redis)', () => {
  it('admits exactly the sender cap under 200 concurrent callers and spaces every slot', async () => {
    const now = hourStart + 1_000;
    const decisions = await Promise.all(
      Array.from({ length: 200 }, () =>
        reserve({ userId: 'u1', senderId: 's1', campaignId: 'c1', now }),
      ),
    );
    const reserved = decisions.filter((d) => d.kind === 'reserved');
    const slots = reserved.map((d) => (d.kind === 'reserved' ? d.slotAt : 0)).sort((a, b) => a - b);

    expect(reserved).toHaveLength(10);
    expect(slots).toEqual(Array.from({ length: 10 }, (_, i) => now + i * 1_000));
    expect(decisions.filter((d) => d.kind === 'quota' && d.scope === 'sender')).toHaveLength(190);
    expect(await redis.zcard(keys.senderQuota('u1', 's1'))).toBe(10);
  });

  it('is a sliding window: the oldest send frees a slot exactly one hour later', async () => {
    const now = hourStart + 1_000;
    for (let i = 0; i < 10; i += 1)
      await reserve({ userId: 'u1', senderId: 's1', campaignId: 'c1', now });
    // The 10 slots are now..now+9s, so the first leaves the window at now+1h.
    const decision = await reserve({ userId: 'u1', senderId: 's1', campaignId: 'c1', now });
    expect(decision).toMatchObject({ kind: 'quota', scope: 'sender', retryAt: now + HOUR });
  });

  it('does not allow a burst across a clock-hour boundary', async () => {
    // 10 sends just before 11:00 must block sends just after 11:00.
    const before = hourStart + HOUR - 30_000;
    for (let i = 0; i < 10; i += 1)
      await reserve({ userId: 'u1', senderId: 's1', campaignId: 'c1', now: before + i * 1_000 });
    const after = await reserve({
      userId: 'u1',
      senderId: 's1',
      campaignId: 'c1',
      now: hourStart + HOUR + 5_000,
    });
    expect(after).toMatchObject({ kind: 'quota', scope: 'sender', retryAt: before + HOUR });
  });

  it('gives quota back when an email is released (cancelled or failed)', async () => {
    const now = hourStart + 1_000;
    const owner = { userId: 'u1', senderId: 's1', campaignId: 'c1' };
    for (let i = 0; i < 10; i += 1) await reserveSendSlot({ ...owner, emailId: `r${i}`, now });
    expect((await reserveSendSlot({ ...owner, emailId: 'x', now })).kind).toBe('quota');
    await releaseQuota([{ ...owner, emailId: 'r3' }]);
    expect((await reserveSendSlot({ ...owner, emailId: 'x', now })).kind).toBe('reserved');
  });

  it('does not charge twice when the same email re-reserves', async () => {
    const now = hourStart + 1_000;
    const owner = { userId: 'u1', senderId: 's1', campaignId: 'c1', emailId: 'same' };
    await reserveSendSlot({ ...owner, now });
    await reserveSendSlot({ ...owner, now: now + 5_000 });
    expect(await redis.zcard(keys.senderQuota('u1', 's1'))).toBe(1);
  });

  it('applies one global cap across tenants', async () => {
    const now = hourStart + 1_000;
    const decisions = await Promise.all(
      Array.from({ length: 80 }, (_, i) =>
        reserve({ userId: `u${i % 4}`, senderId: `s${i}`, campaignId: `c${i}`, now }),
      ),
    );
    expect(decisions.filter((d) => d.kind === 'reserved')).toHaveLength(60);
    expect(decisions.some((d) => d.kind === 'quota' && d.scope === 'global')).toBe(true);
  });

  it('rebuilds quota counters from PostgreSQL after Redis loses them', async () => {
    const tenant = await createTenant();
    const { emails } = await createCampaign(tenant, 3);
    const sentAt = new Date();
    await prisma.email.updateMany({
      where: { id: { in: emails.map((e) => e.id) } },
      data: { status: 'SENT', sentAt },
    });
    await redis.flushdb(); // Redis restarts empty
    expect(await ensureQuotaState()).toEqual({ rebuilt: expect.any(Number) });
    const first = emails[0]!;
    expect(await redis.zcard(keys.tenantQuota(first.userId))).toBe(3);
    expect(await ensureQuotaState()).toBeNull(); // marker present: no second rebuild
  });

  it('enforces a campaign cap independently of other campaigns from the same sender', async () => {
    const now = hourStart + 1_000;
    const run = (campaignId: string, limit: number) =>
      reserve({
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
        reserve({ userId: 'u1', senderId: `s${i % 4}`, campaignId: `c${i % 4}`, now }),
      ),
    );
    expect(decisions.filter((d) => d.kind === 'reserved')).toHaveLength(25);
    expect(decisions.some((d) => d.kind === 'quota' && d.scope === 'tenant')).toBe(true);
  });

  it('isolates tenants', async () => {
    const now = hourStart + 1_000;
    for (let i = 0; i < 10; i += 1)
      await reserve({ userId: 'u1', senderId: 's1', campaignId: 'c', now });
    const other = await reserve({ userId: 'u2', senderId: 's1', campaignId: 'c', now });
    expect(other.kind).toBe('reserved');
  });

  it('defers instead of reserving beyond the look-ahead horizon', async () => {
    const now = hourStart + 1_000;
    await redis.set(keys.senderPace('u1', 's1'), String(now + RESERVATION_HORIZON_MS + 5_000));
    const decision = await reserve({ userId: 'u1', senderId: 's1', campaignId: 'c', now });
    expect(decision).toEqual({ kind: 'defer', retryAt: now + 6_000 });
    expect(await redis.zcard(keys.senderQuota('u1', 's1'))).toBe(0);
  });
});
