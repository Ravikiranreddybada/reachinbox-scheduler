import { Router } from 'express';
import { z } from 'zod';
import { publishEvent } from '../events/publisher.js';
import { asyncHandler } from '../http/asyncHandler.js';
import { HttpError } from '../http/errors.js';
import { prisma } from '../lib/infra.js';
import { logger } from '../lib/logger.js';
import { increment } from '../observability/metrics.js';
import { emailQueue, enqueueSearchSync } from '../queues/emailQueue.js';
import { releaseQuota } from '../services/deliveryGate.js';

const router = Router();
const idParam = z.object({ id: z.string().cuid() });
const listSchema = z.object({
  cursor: z.string().cuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

type Progress = Record<'SCHEDULED' | 'PROCESSING' | 'SENT' | 'FAILED' | 'CANCELLED', number>;
const emptyProgress = (): Progress => ({
  SCHEDULED: 0,
  PROCESSING: 0,
  SENT: 0,
  FAILED: 0,
  CANCELLED: 0,
});

async function progressFor(campaignIds: string[]): Promise<Map<string, Progress>> {
  const groups = await prisma.email.groupBy({
    by: ['campaignId', 'status'],
    where: { campaignId: { in: campaignIds } },
    _count: { _all: true },
  });
  const map = new Map<string, Progress>();
  for (const group of groups) {
    const progress = map.get(group.campaignId) ?? emptyProgress();
    progress[group.status] = group._count._all;
    map.set(group.campaignId, progress);
  }
  return map;
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = listSchema.parse(req.query);
    const campaigns = await prisma.campaign.findMany({
      where: { userId: req.userId! },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        subject: true,
        recipientCount: true,
        hourlyLimit: true,
        startsAt: true,
        createdAt: true,
      },
    });
    const hasMore = campaigns.length > query.limit;
    if (hasMore) campaigns.pop();
    const progress = await progressFor(campaigns.map((campaign) => campaign.id));
    res.json({
      items: campaigns.map((campaign) => ({
        ...campaign,
        progress: progress.get(campaign.id) ?? emptyProgress(),
      })),
      nextCursor: hasMore ? campaigns.at(-1)?.id : null,
    });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const campaign = await prisma.campaign.findFirst({
      where: { id, userId: req.userId! },
      select: {
        id: true,
        subject: true,
        recipientCount: true,
        hourlyLimit: true,
        startsAt: true,
        createdAt: true,
      },
    });
    if (!campaign) throw new HttpError(404, 'Campaign not found');
    const progress = await progressFor([id]);
    res.json({ ...campaign, progress: progress.get(id) ?? emptyProgress() });
  }),
);

/**
 * Cancels every email of the campaign that no worker has claimed yet.
 * Emails already PROCESSING finish normally; the response says how many.
 */
router.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const userId = req.userId!;
    const owned = await prisma.campaign.count({ where: { id, userId } });
    if (!owned) throw new HttpError(404, 'Campaign not found');

    const targets = await prisma.email.findMany({
      where: { campaignId: id, userId, status: 'SCHEDULED' },
      select: { id: true, senderId: true },
    });
    const ids = targets.map((row) => row.id);
    const result = await prisma.email.updateMany({
      where: { id: { in: ids }, status: 'SCHEDULED' },
      data: { status: 'CANCELLED' },
    });
    const removals = await Promise.allSettled(ids.map((emailId) => emailQueue.remove(emailId)));
    const inFlight = await prisma.email.count({ where: { campaignId: id, status: 'PROCESSING' } });

    await releaseQuota(
      targets.map((row) => ({ userId, senderId: row.senderId, campaignId: id, emailId: row.id })),
    ).catch(() => undefined);
    increment('emails_cancelled_total', result.count);
    publishEvent(userId, { type: 'campaign.cancelled', campaignId: id, count: result.count });
    void enqueueSearchSync(ids).catch(() => undefined);
    logger.info({
      event: 'campaign.cancelled',
      campaignId: id,
      cancelled: result.count,
      jobsRemoved: removals.filter((r) => r.status === 'fulfilled').length,
      inFlight,
    });
    res.json({ campaignId: id, cancelled: result.count, inFlight });
  }),
);

export default router;
