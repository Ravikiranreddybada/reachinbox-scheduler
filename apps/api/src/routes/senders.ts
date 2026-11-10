import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../http/asyncHandler.js';
import { HttpError } from '../http/errors.js';
import { encryptSecret } from '../lib/crypto.js';
import { prisma } from '../lib/infra.js';
import { verifySmtpLogin } from '../services/transports.js';

/**
 * Sender addresses of the signed-in user. Each sender can have its own SMTP
 * login; a sender without one sends through the shared default account.
 */
const router = Router();
const idParam = z.object({ id: z.string().cuid() });
const smtpSchema = z.object({
  user: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(500),
  /** Check the login against the SMTP server first. Skipped for the stream transport. */
  verify: z.boolean().default(true),
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const senders = await prisma.sender.findMany({
      where: { userId: req.userId! },
      select: { id: true, email: true, displayName: true, smtpUser: true },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    res.json({
      items: senders.map(({ smtpUser, ...sender }) => ({ ...sender, smtpConfigured: !!smtpUser })),
    });
  }),
);

router.put(
  '/:id/smtp',
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const body = smtpSchema.parse(req.body);
    const owned = await prisma.sender.count({ where: { id, userId: req.userId! } });
    if (!owned) throw new HttpError(404, 'Sender not found');
    if (body.verify) {
      await verifySmtpLogin(body.user, body.password).catch(() => {
        throw new HttpError(422, 'The SMTP server rejected this login.', 'SMTP_LOGIN_REJECTED');
      });
    }
    await prisma.sender.update({
      where: { id },
      data: { smtpUser: body.user, smtpPassword: encryptSecret(body.password) },
    });
    res.json({ id, smtpConfigured: true });
  }),
);

router.delete(
  '/:id/smtp',
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const result = await prisma.sender.updateMany({
      where: { id, userId: req.userId! },
      data: { smtpUser: null, smtpPassword: null },
    });
    if (!result.count) throw new HttpError(404, 'Sender not found');
    res.status(204).end();
  }),
);

export default router;
