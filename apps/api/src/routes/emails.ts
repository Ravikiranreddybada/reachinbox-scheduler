import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { buildSchedulePlan } from '../domain/schedulePlan.js';
import { publishEvent } from '../events/publisher.js';
import { asyncHandler } from '../http/asyncHandler.js';
import { HttpError } from '../http/errors.js';
import { htmlToText, sanitizeEmailHtml } from '../lib/html.js';
import { prisma } from '../lib/infra.js';
import { logger } from '../lib/logger.js';
import { increment } from '../observability/metrics.js';
import { emailQueue, enqueueDeliveries, enqueueSearchSync } from '../queues/emailQueue.js';
import { releaseQuota } from '../services/deliveryGate.js';
import { searchEmails } from '../services/search.js';

const router = Router();
const MAX_RECIPIENTS = 5000;
const PREVIEW_LENGTH = 140;
const address = z.string().trim().toLowerCase().email().max(254);
const statuses = z.enum(['SCHEDULED', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED']);
const statusList = z
  .string()
  .transform((value) => value.toUpperCase().split(',').filter(Boolean))
  .pipe(z.array(statuses).min(1).max(5));

const scheduleSchema = z.object({
  sender: address,
  senderName: z.string().trim().max(120).optional(),
  recipients: z.array(address).min(1).max(MAX_RECIPIENTS),
  subject: z
    .string()
    .trim()
    .min(1)
    .max(998)
    .refine((value) => !/[\r\n]/.test(value), 'Subject must be a single line'),
  body: z.string().min(1).max(100_000),
  scheduledAt: z.string().datetime({ offset: true }),
  delayBetweenMs: z.number().int().min(0).max(3_600_000).default(0),
  hourlyLimit: z.number().int().min(1).max(10_000).optional(),
  attachmentIds: z.array(z.string().cuid()).max(10).default([]),
  idempotencyKey: z.string().trim().min(8).max(128),
});

const listSchema = z.object({
  status: statusList.optional(),
  starred: z.enum(['true', 'false']).optional(),
  archived: z.enum(['true', 'false']).optional(),
  campaignId: z.string().cuid().optional(),
  cursor: z.string().cuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const idParam = z.object({ id: z.string().cuid() });

const listSelect = {
  id: true,
  campaignId: true,
  recipient: true,
  subject: true,
  body: true,
  status: true,
  scheduledAt: true,
  sentAt: true,
  attempts: true,
  errorMessage: true,
  providerMessageId: true,
  starred: true,
  archivedAt: true,
} satisfies Prisma.EmailSelect;

/** The list never ships full bodies (up to 100 KB each); a preview is enough. */
function toListItem({ body, ...email }: Prisma.EmailGetPayload<{ select: typeof listSelect }>) {
  const flat = htmlToText(body).replace(/\s+/g, ' ');
  return {
    ...email,
    preview: flat.length > PREVIEW_LENGTH ? `${flat.slice(0, PREVIEW_LENGTH)}…` : flat,
  };
}

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const parsed = scheduleSchema.parse(req.body);
    const data = { ...parsed, body: sanitizeEmailHtml(parsed.body) };
    if (!htmlToText(data.body)) {
      throw new HttpError(400, 'Write a message before sending.', 'EMPTY_BODY');
    }
    const plan = buildSchedulePlan(data);
    const startAt = plan.emails[0]!.scheduledAt;

    const findCampaign = () =>
      prisma.campaign.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey: data.idempotencyKey } },
        select: { id: true, payloadHash: true },
      });

    if (data.attachmentIds.length) {
      const owned = await prisma.attachment.count({
        where: { id: { in: data.attachmentIds }, userId },
      });
      if (owned !== new Set(data.attachmentIds).size) {
        throw new HttpError(
          422,
          'An attachment was not found. Upload it again.',
          'ATTACHMENT_MISSING',
        );
      }
    }
    let campaign = await findCampaign();
    let replayed = Boolean(campaign);
    if (campaign && campaign.payloadHash !== plan.payloadHash) {
      throw new HttpError(
        409,
        'This idempotency key was already used with a different request payload.',
        'IDEMPOTENCY_KEY_REUSED',
      );
    }
    // The clock check only applies to new work; a replay of an accepted
    // request must succeed even after its start time has passed.
    if (!campaign && startAt.getTime() < Date.now() - 60_000) {
      throw new HttpError(422, 'scheduledAt must not be in the past.', 'SCHEDULE_IN_PAST');
    }

    if (!campaign) {
      try {
        campaign = await prisma.$transaction(async (tx) => {
          // INSERT ... ON CONFLICT DO NOTHING is race-safe; Prisma's upsert is
          // a read-then-write that fails when two requests add one sender.
          await tx.sender.createMany({
            data: [{ userId, email: data.sender, displayName: data.senderName }],
            skipDuplicates: true,
          });
          const sender = await tx.sender.findUniqueOrThrow({
            where: { userId_email: { userId, email: data.sender } },
            select: { id: true, displayName: true },
          });
          if (data.senderName && sender.displayName !== data.senderName) {
            await tx.sender.update({
              where: { id: sender.id },
              data: { displayName: data.senderName },
            });
          }
          const created = await tx.campaign.create({
            data: {
              userId,
              idempotencyKey: data.idempotencyKey,
              payloadHash: plan.payloadHash,
              hourlyLimit: data.hourlyLimit,
              subject: data.subject,
              recipientCount: plan.emails.length,
              startsAt: startAt,
            },
            select: { id: true, payloadHash: true },
          });
          if (data.attachmentIds.length) {
            await tx.attachment.updateMany({
              where: { id: { in: data.attachmentIds }, userId },
              data: { campaignId: created.id },
            });
          }
          await tx.email.createMany({
            data: plan.emails.map((email) => ({
              userId,
              senderId: sender.id,
              campaignId: created.id,
              recipient: email.recipient,
              subject: data.subject,
              body: data.body,
              scheduledAt: email.scheduledAt,
              idempotencyKey: email.idempotencyKey,
            })),
          });
          return created;
        });
      } catch (error) {
        // Two requests with one key raced; the unique index picked one
        // winner, and the conflicting INSERT waited for it to commit.
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
          throw error;
        }
        campaign = await findCampaign();
        replayed = true;
        if (!campaign || campaign.payloadHash !== plan.payloadHash) {
          throw new HttpError(409, 'Idempotency key conflict.', 'IDEMPOTENCY_KEY_REUSED');
        }
      }
    }

    // Publishing after commit is safe to repeat: job IDs are email IDs. If
    // Redis fails here the rows are committed, and either a client retry
    // (same key) or the reconciler publishes them.
    const pending = await prisma.email.findMany({
      where: { userId, campaignId: campaign.id, status: 'SCHEDULED' },
      select: { id: true, scheduledAt: true },
    });
    await enqueueDeliveries(pending);
    const counts = await prisma.email.groupBy({
      by: ['status'],
      where: { campaignId: campaign.id },
      _count: { _all: true },
    });
    const accepted = counts.reduce((sum, group) => sum + group._count._all, 0);

    if (!replayed) {
      const ids = await prisma.email.findMany({
        where: { campaignId: campaign.id },
        select: { id: true },
      });
      enqueueSearchSync(ids.map((row) => row.id)).catch((error) =>
        logger.warn({ event: 'search.enqueue_failed', campaignId: campaign.id, err: error }),
      );
      publishEvent(userId, { type: 'campaign.accepted', campaignId: campaign.id, count: accepted });
      logger.info({ event: 'campaign.accepted', userId, campaignId: campaign.id, accepted });
    }

    res
      .status(replayed ? 200 : 202)
      .location(`/api/campaigns/${campaign.id}`)
      .json({
        campaignId: campaign.id,
        accepted,
        duplicatesRemoved: data.recipients.length - plan.emails.length,
        replayed,
        startsAt: startAt,
        endsAt: plan.emails.at(-1)!.scheduledAt,
        byStatus: Object.fromEntries(counts.map((group) => [group.status, group._count._all])),
      });
  }),
);

router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const groups = await prisma.email.groupBy({
      by: ['status'],
      where: { userId: req.userId!, deletedAt: null, archivedAt: null },
      _count: { _all: true },
    });
    const counts = { scheduled: 0, processing: 0, sent: 0, failed: 0, cancelled: 0 };
    for (const group of groups) {
      counts[group.status.toLowerCase() as keyof typeof counts] = group._count._all;
    }
    res.json(counts);
  }),
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = listSchema.parse(req.query);
    const where: Prisma.EmailWhereInput = {
      userId: req.userId!,
      deletedAt: null,
      archivedAt: query.archived === 'true' ? { not: null } : null,
      ...(query.starred ? { starred: query.starred === 'true' } : {}),
      ...(query.status ? { status: { in: query.status } } : {}),
      ...(query.campaignId ? { campaignId: query.campaignId } : {}),
    };
    const sentView = query.status?.every((status) => status === 'SENT' || status === 'FAILED');
    const items = await prisma.email.findMany({
      where,
      select: listSelect,
      orderBy: sentView
        ? [{ sentAt: 'desc' }, { id: 'desc' }]
        : [{ scheduledAt: 'asc' }, { id: 'asc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const hasMore = items.length > query.limit;
    if (hasMore) items.pop();
    res.json({ items: items.map(toListItem), nextCursor: hasMore ? items.at(-1)?.id : null });
  }),
);

router.get(
  '/search',
  asyncHandler(async (req, res) => {
    const query = z
      .object({ q: z.string().trim().min(1).max(200), status: statusList.optional() })
      .parse(req.query);
    try {
      const found = await searchEmails(req.userId!, query.q, query.status);
      // Elasticsearch is a projection: star/archive/delete live in PostgreSQL.
      const rows = await prisma.email.findMany({
        where: { id: { in: found.items.map((item) => item.id) }, userId: req.userId! },
        select: { id: true, starred: true, archivedAt: true, deletedAt: true },
      });
      const state = new Map(rows.map((row) => [row.id, row]));
      const items = found.items
        .filter((item) => {
          const row = state.get(item.id);
          return row && !row.deletedAt && !row.archivedAt;
        })
        .map((item) => ({ ...item, starred: state.get(item.id)!.starred }));
      res.json({ items, total: items.length });
      return;
    } catch (error) {
      logger.warn({ event: 'search.query_failed', err: error });
      throw new HttpError(503, 'Search is temporarily unavailable.', 'SEARCH_UNAVAILABLE');
    }
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const email = await prisma.email.findFirst({
      where: { id, userId: req.userId! },
      include: { sender: { select: { email: true, displayName: true } } },
    });
    if (!email) throw new HttpError(404, 'Email not found');
    if (email.deletedAt) throw new HttpError(404, 'Email not found');
    const attachments = await prisma.attachment.findMany({
      where: { campaignId: email.campaignId, userId: req.userId! },
      select: { id: true, filename: true, contentType: true, size: true },
      orderBy: { createdAt: 'asc' },
    });
    const { idempotencyKey: _key, userId: _user, ...rest } = email;
    res.json({ ...rest, attachments });
  }),
);

const patchSchema = z
  .object({ starred: z.boolean().optional(), archived: z.boolean().optional() })
  .refine((value) => value.starred !== undefined || value.archived !== undefined, {
    message: 'Provide starred or archived.',
  });

/** Star and archive toggles. Both are idempotent, so a repeat click is harmless. */
router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const patch = patchSchema.parse(req.body);
    const result = await prisma.email.updateMany({
      where: { id, userId: req.userId!, deletedAt: null },
      data: {
        ...(patch.starred !== undefined ? { starred: patch.starred } : {}),
        ...(patch.archived !== undefined ? { archivedAt: patch.archived ? new Date() : null } : {}),
      },
    });
    if (!result.count) throw new HttpError(404, 'Email not found');
    const email = await prisma.email.findUniqueOrThrow({
      where: { id },
      select: { id: true, starred: true, archivedAt: true },
    });
    res.json(email);
  }),
);

/**
 * Deletes an email from the user's view (soft delete). A scheduled email is
 * cancelled first with the same compare-and-set as /cancel, so deleting can
 * never leave a message that still sends. One being sent right now is refused.
 */
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const userId = req.userId!;
    const email = await prisma.email.findFirst({
      where: { id, userId, deletedAt: null },
      select: { status: true, campaignId: true, senderId: true },
    });
    if (!email) throw new HttpError(404, 'Email not found');
    if (email.status === 'PROCESSING') {
      throw new HttpError(409, 'This email is being sent right now. Try again in a moment.');
    }
    if (email.status === 'SCHEDULED') {
      const cancelled = await prisma.email.updateMany({
        where: { id, userId, status: 'SCHEDULED' },
        data: { status: 'CANCELLED', errorMessage: null },
      });
      if (!cancelled.count) {
        throw new HttpError(409, 'This email was just picked up for sending. Try again.');
      }
      await emailQueue.remove(id).catch(() => 0);
      await releaseQuota([
        { userId, senderId: email.senderId, campaignId: email.campaignId, emailId: id },
      ]).catch(() => undefined);
      increment('emails_cancelled_total');
    }
    await prisma.email.update({ where: { id }, data: { deletedAt: new Date() } });
    publishEvent(userId, {
      type: 'email.status',
      emailId: id,
      campaignId: email.campaignId,
      status: 'CANCELLED',
      at: new Date().toISOString(),
    });
    void enqueueSearchSync([id]).catch(() => undefined);
    res.status(204).end();
  }),
);

/**
 * Cancels one scheduled email. The status predicate makes this a
 * compare-and-set: an email that a worker already claimed cannot be
 * cancelled, which avoids reporting "cancelled" for a message that is sent.
 */
router.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const userId = req.userId!;
    const result = await prisma.email.updateMany({
      where: { id, userId, status: 'SCHEDULED' },
      data: { status: 'CANCELLED', errorMessage: null },
    });
    if (!result.count) {
      const email = await prisma.email.findFirst({
        where: { id, userId },
        select: { status: true },
      });
      if (!email) throw new HttpError(404, 'Email not found');
      throw new HttpError(409, `Email is ${email.status.toLowerCase()} and cannot be cancelled.`);
    }
    // Removing the job is an optimisation; the worker also skips cancelled rows.
    await emailQueue.remove(id).catch(() => 0);
    const email = await prisma.email.findUniqueOrThrow({
      where: { id },
      select: { campaignId: true, senderId: true },
    });
    await releaseQuota([
      { userId, senderId: email.senderId, campaignId: email.campaignId, emailId: id },
    ]).catch(() => undefined);
    increment('emails_cancelled_total');
    publishEvent(userId, {
      type: 'email.status',
      emailId: id,
      campaignId: email.campaignId,
      status: 'CANCELLED',
      at: new Date().toISOString(),
    });
    void enqueueSearchSync([id]).catch(() => undefined);
    res.json({ id, status: 'CANCELLED' });
  }),
);

/**
 * Retries a FAILED email now. Compare-and-set on FAILED, so a double click or
 * two tabs cannot schedule it twice; the old terminal BullMQ job is replaced
 * by a fresh one with the same ID. Hourly limits and pacing apply again.
 */
router.post(
  '/:id/retry',
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const userId = req.userId!;
    const scheduledAt = new Date();
    const result = await prisma.email.updateMany({
      where: { id, userId, status: 'FAILED' },
      data: { status: 'SCHEDULED', scheduledAt, errorMessage: null, processingStartedAt: null },
    });
    if (!result.count) {
      const email = await prisma.email.findFirst({
        where: { id, userId },
        select: { status: true },
      });
      if (!email) throw new HttpError(404, 'Email not found');
      throw new HttpError(
        409,
        `Only failed emails can be retried; this one is ${email.status.toLowerCase()}.`,
      );
    }
    await emailQueue.remove(id).catch(() => 0);
    await enqueueDeliveries([{ id, scheduledAt }]);
    const email = await prisma.email.findUniqueOrThrow({
      where: { id },
      select: { campaignId: true },
    });
    publishEvent(userId, {
      type: 'email.status',
      emailId: id,
      campaignId: email.campaignId,
      status: 'SCHEDULED',
      at: scheduledAt.toISOString(),
    });
    void enqueueSearchSync([id]).catch(() => undefined);
    logger.info({ event: 'email.retry_requested', emailId: id, userId });
    res.json({ id, status: 'SCHEDULED', scheduledAt });
  }),
);

export default router;
