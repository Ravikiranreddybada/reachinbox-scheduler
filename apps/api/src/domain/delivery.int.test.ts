import { afterAll, describe, expect, it } from 'vitest';
import { createCampaign, createTenant } from '../../test/fixtures.js';
import { prisma } from '../lib/infra.js';
import { claimEmail } from './delivery.js';

afterAll(async () => {
  await prisma.$disconnect();
});

describe('claimEmail (real PostgreSQL)', () => {
  it('lets exactly one of 25 concurrent workers claim an email', async () => {
    const { emails } = await createCampaign(await createTenant(), 1);
    const results = await Promise.all(
      Array.from({ length: 25 }, () => claimEmail(emails[0]!.id, new Date(), 300_000)),
    );
    expect(results.filter((r) => r.kind === 'claimed')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'held')).toHaveLength(24);
    const row = await prisma.email.findUniqueOrThrow({ where: { id: emails[0]!.id } });
    expect(row).toMatchObject({ status: 'PROCESSING', attempts: 1 });
  });

  it('reclaims a PROCESSING row whose lease expired', async () => {
    const { emails } = await createCampaign(await createTenant(), 1);
    await prisma.email.update({
      where: { id: emails[0]!.id },
      data: { status: 'PROCESSING', processingStartedAt: new Date(Date.now() - 600_000) },
    });
    expect(await claimEmail(emails[0]!.id, new Date(), 300_000)).toMatchObject({ kind: 'claimed' });
  });

  it('never claims a terminal email', async () => {
    const { emails } = await createCampaign(await createTenant(), 1);
    await prisma.email.update({ where: { id: emails[0]!.id }, data: { status: 'CANCELLED' } });
    expect(await claimEmail(emails[0]!.id, new Date(), 300_000)).toEqual({ kind: 'terminal' });
  });
});
