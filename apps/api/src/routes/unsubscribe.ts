import express, { Router } from 'express';
import { asyncHandler } from '../http/asyncHandler.js';
import { escapeHtml } from '../lib/html.js';
import { prisma } from '../lib/infra.js';
import { verifyUnsubscribeToken } from '../lib/unsubscribe.js';
import { suppressRecipient } from '../services/suppressions.js';

/**
 * Public unsubscribe endpoint. The signed token is the only credential and it
 * can do one thing. GET shows a confirm page (mail scanners prefetch links, so
 * a GET must not unsubscribe); POST performs it, which is also what RFC 8058
 * one-click mail clients send.
 */
const router = Router();

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:420px;margin:15vh auto;padding:0 16px;color:#1f2937}
button{font:inherit;padding:10px 18px;border:0;border-radius:8px;background:#2563eb;color:#fff;cursor:pointer}</style>
</head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;

async function load(token: string) {
  const emailId = verifyUnsubscribeToken(token);
  if (!emailId) return null;
  return prisma.email.findUnique({
    where: { id: emailId },
    select: { userId: true, recipient: true },
  });
}

router.get(
  '/:token',
  asyncHandler(async (req, res) => {
    const email = await load(String(req.params.token));
    if (!email)
      return res
        .status(404)
        .type('html')
        .send(page('Link not valid', '<p>This link is invalid or expired.</p>'));
    res.type('html').send(
      page(
        'Unsubscribe',
        `<p>Stop emails to <b>${escapeHtml(email.recipient)}</b>?</p>
<form method="post"><button type="submit">Unsubscribe</button></form>`,
      ),
    );
  }),
);

router.post(
  '/:token',
  express.urlencoded({ extended: false, limit: '1kb' }),
  asyncHandler(async (req, res) => {
    const email = await load(String(req.params.token));
    if (!email)
      return res
        .status(404)
        .type('html')
        .send(page('Link not valid', '<p>This link is invalid or expired.</p>'));
    await suppressRecipient(email.userId, email.recipient, 'UNSUBSCRIBE', 'Unsubscribe link');
    res
      .type('html')
      .send(
        page(
          'You are unsubscribed',
          `<p>${escapeHtml(email.recipient)} will not get more emails from this sender.</p>`,
        ),
      );
  }),
);

export default router;
