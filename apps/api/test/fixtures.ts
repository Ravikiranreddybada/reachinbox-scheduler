import { randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/infra.js';

export async function createTenant(label = 'tenant') {
  const suffix = randomUUID().slice(0, 8);
  const user = await prisma.user.create({
    data: { googleId: `g-${suffix}`, email: `${label}-${suffix}@example.com`, name: label },
  });
  const sender = await prisma.sender.create({
    data: { userId: user.id, email: `sender-${suffix}@example.com` },
  });
  return { user, sender };
}

export async function createCampaign(
  tenant: Awaited<ReturnType<typeof createTenant>>,
  recipients: number,
  options: { scheduledAt?: Date; hourlyLimit?: number } = {},
) {
  const campaign = await prisma.campaign.create({
    data: {
      userId: tenant.user.id,
      idempotencyKey: randomUUID(),
      payloadHash: randomUUID(),
      hourlyLimit: options.hourlyLimit,
      subject: 'Integration',
      body: 'Hello from the integration suite.',
      preview: 'Hello from the integration suite.',
      recipientCount: recipients,
    },
  });
  const scheduledAt = options.scheduledAt ?? new Date();
  await prisma.email.createMany({
    data: Array.from({ length: recipients }, (_, index) => ({
      userId: tenant.user.id,
      senderId: tenant.sender.id,
      campaignId: campaign.id,
      recipient: `r${index}@example.com`,
      subject: 'Integration',
      scheduledAt,
      idempotencyKey: randomUUID(),
    })),
  });
  const emails = await prisma.email.findMany({ where: { campaignId: campaign.id } });
  return { campaign, emails };
}
