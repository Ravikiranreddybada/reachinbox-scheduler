import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../http/asyncHandler.js';
import { HttpError } from '../http/errors.js';
import { prisma } from '../lib/infra.js';
import { suppressRecipient } from '../services/suppressions.js';

/** The user's suppression list: unsubscribes, bounces, and complaints. */
const router = Router();
const idParam = z.object({ id: z.string().cuid() });
const createSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  reason: z.enum(['UNSUBSCRIBE', 'BOUNCE', 'COMPLAINT']).default('COMPLAINT'),
  note: z.string().trim().max(500).optional(),
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const items = await prisma.suppression.findMany({
      where: { userId: req.userId! },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { id: true, email: true, reason: true, note: true, createdAt: true },
    });
    res.json({ items });
  }),
);

/** Manual entry, and the hook a provider's complaint or bounce webhook can call. */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    const { cancelled } = await suppressRecipient(req.userId!, body.email, body.reason, body.note);
    res.status(201).json({ email: body.email, reason: body.reason, cancelled });
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const result = await prisma.suppression.deleteMany({ where: { id, userId: req.userId! } });
    if (!result.count) throw new HttpError(404, 'Suppression not found');
    res.status(204).end();
  }),
);

export default router;
