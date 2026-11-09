import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { buildSchedulePlan } from '../domain/schedulePlan.js';
import { prisma } from '../lib/infra.js';
import { emailQueue } from '../queues/emailQueue.js';
import { indexEmail, searchEmails } from '../services/search.js';

const router = Router();
const address = z.string().trim().email().max(254);
const statuses = z.enum(['SCHEDULED', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED']);

const scheduleSchema = z.object({
  sender: address,
  senderName: z.string().trim().max(120).optional(),
  recipients: z.array(address).min(1).max(5000),
  subject: z.string().trim().min(1).max(998),
  body: z.string().min(1).max(100000),
  scheduledAt: z.string().datetime({ offset: true }),
  delayBetweenMs: z.number().int().min(0).max(3600000).default(0),
  hourlyLimit: z.number().int().min(1).max(10000).optional(),
  idempotencyKey: z.string().trim().min(8).max(128),
});

const listSchema = z.object({
  status: z
    .string()
    .transform((value) => value.toUpperCase().split(',').filter(Boolean))
    .pipe(z.array(statuses).min(1))
    .optional(),
  cursor: z.string().cuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

router.post('/', async (req, res, next) => {
  try {
    const userId = req.userId!;
    const data = scheduleSchema.parse(req.body);
    const startAt = new Date(data.scheduledAt);
    const plan = buildSchedulePlan(data);
    const existingCampaign = await prisma.campaign.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey: data.idempotencyKey } },
    });
    if (existingCampaign && existingCampaign.payloadHash !== plan.payloadHash) {
      return res.status(409).json({
        error: 'This idempotency key was already used with a different request payload.',
      });
    }
    if (!existingCampaign && startAt.getTime() < Date.now() - 5000) {
      return res.status(422).json({ error: 'scheduledAt must be in the future' });
    }

    let campaignId = existingCampaign?.id;
    if (!campaignId) {
      try {
        const created = await prisma.$transaction(async (tx) => {
          const sender = await tx.sender.upsert({
            where: { userId_email: { userId, email: data.sender.toLowerCase() } },
            update: { displayName: data.senderName },
            create: {
              userId,
              email: data.sender.toLowerCase(),
              displayName: data.senderName,
            },
          });
          const campaign = await tx.campaign.create({
            data: {
              userId,
              idempotencyKey: data.idempotencyKey,
              payloadHash: plan.payloadHash,
              hourlyLimit: data.hourlyLimit,
            },
          });
          await tx.email.createMany({
            data: plan.emails.map((email) => ({
              userId,
              senderId: sender.id,
              campaignId: campaign.id,
              recipient: email.recipient,
              subject: data.subject,
              body: data.body,
              scheduledAt: email.scheduledAt,
              idempotencyKey: email.idempotencyKey,
            })),
          });
          return campaign;
        });
        campaignId = created.id;
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
          throw error;
        }
        const raced = await prisma.campaign.findUniqueOrThrow({
          where: { userId_idempotencyKey: { userId, idempotencyKey: data.idempotencyKey } },
        });
        if (raced.payloadHash !== plan.payloadHash) {
          return res.status(409).json({ error: 'Idempotency key conflict.' });
        }
        campaignId = raced.id;
      }
    }

    const emails = await prisma.email.findMany({
      where: { userId, campaignId },
      orderBy: { scheduledAt: 'asc' },
    });
    const pending = emails.filter((email) => email.status === 'SCHEDULED');
    await emailQueue.addBulk(
      pending.map((email) => ({
        name: 'deliver',
        data: { emailId: email.id },
        opts: { jobId: email.id, delay: Math.max(0, email.scheduledAt.getTime() - Date.now()) },
      })),
    );

    const indexing = await Promise.allSettled(emails.map((email) => indexEmail(email)));
    if (indexing.some((result) => result.status === 'rejected')) {
      console.warn('Some search documents could not be indexed; rebuild from PostgreSQL.');
    }
    res.status(existingCampaign ? 200 : 202).json({
      campaignId,
      accepted: emails.length,
      replayed: Boolean(existingCampaign),
      emails: emails.map((email) => ({
        id: email.id,
        recipient: email.recipient,
        status: email.status,
        scheduledAt: email.scheduledAt,
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/stats', async (req, res, next) => {
  try {
    const groups = await prisma.email.groupBy({
      by: ['status'],
      where: { userId: req.userId! },
      _count: { _all: true },
    });
    const counts = { scheduled: 0, processing: 0, sent: 0, failed: 0, cancelled: 0 };
    for (const group of groups) {
      counts[group.status.toLowerCase() as keyof typeof counts] = group._count._all;
    }
    res.json(counts);
  } catch (error) {
    next(error);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const query = listSchema.parse(req.query);
    const where: Prisma.EmailWhereInput = {
      userId: req.userId!,
      ...(query.status ? { status: { in: query.status } } : {}),
    };
    const items = await prisma.email.findMany({
      where,
      orderBy: query.status?.includes('SENT')
        ? [{ sentAt: 'desc' }, { id: 'desc' }]
        : [{ scheduledAt: 'asc' }, { id: 'asc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const hasMore = items.length > query.limit;
    if (hasMore) items.pop();
    res.json({ items, nextCursor: hasMore ? items.at(-1)?.id : null });
  } catch (error) {
    next(error);
  }
});

router.get('/search', async (req, res, next) => {
  try {
    const query = z
      .object({
        q: z.string().trim().min(1).max(200),
        status: z
          .string()
          .transform((value) => value.toUpperCase().split(',').filter(Boolean))
          .pipe(z.array(statuses).min(1))
          .optional(),
      })
      .parse(req.query);
    res.json({ items: await searchEmails(req.userId!, query.q, query.status) });
  } catch (error) {
    next(error);
  }
});

export default router;
