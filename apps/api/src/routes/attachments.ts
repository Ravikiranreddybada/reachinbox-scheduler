import express, { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../http/asyncHandler.js';
import { HttpError } from '../http/errors.js';
import { prisma } from '../lib/infra.js';

const router = Router();
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_PENDING_PER_USER = 20;
const idParam = z.object({ id: z.string().cuid() });
/** Only these types render inline; everything else downloads, so uploads cannot run script. */
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * Raw-body upload: `POST /api/attachments` with the file as the body and the
 * name in `X-Filename` (URL-encoded). No multipart parser is needed.
 */
router.post(
  '/',
  express.raw({ type: () => true, limit: MAX_ATTACHMENT_BYTES }),
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const body = req.body as Buffer | undefined;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new HttpError(400, 'The file is empty.');
    }
    let filename = 'attachment';
    try {
      filename = decodeURIComponent(req.get('x-filename') ?? '').trim() || filename;
    } catch {
      // keep the default name
    }
    filename = filename.replace(/[\\/\r\n"]/g, '_').slice(0, 200);
    const contentType = (req.get('content-type') ?? 'application/octet-stream')
      .split(';')[0]!
      .trim()
      .toLowerCase();
    const pending = await prisma.attachment.count({ where: { userId, campaignId: null } });
    if (pending >= MAX_PENDING_PER_USER) {
      throw new HttpError(429, 'Too many unsent attachments. Send or remove some first.');
    }
    const created = await prisma.attachment.create({
      data: { userId, filename, contentType, size: body.length, data: new Uint8Array(body) },
      select: { id: true, filename: true, contentType: true, size: true },
    });
    res.status(201).json(created);
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const file = await prisma.attachment.findFirst({ where: { id, userId: req.userId! } });
    if (!file) throw new HttpError(404, 'Attachment not found');
    const inline = INLINE_TYPES.has(file.contentType) && req.query.download !== '1';
    res.setHeader(
      'Content-Type',
      INLINE_TYPES.has(file.contentType) ? file.contentType : 'application/octet-stream',
    );
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    );
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(Buffer.from(file.data));
  }),
);

/** Removes an attachment that was uploaded but not yet sent with a campaign. */
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const result = await prisma.attachment.deleteMany({
      where: { id, userId: req.userId!, campaignId: null },
    });
    if (!result.count) throw new HttpError(404, 'Attachment not found or already sent');
    res.status(204).end();
  }),
);

export default router;
