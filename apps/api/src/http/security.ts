import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF defence in depth for cookie-authenticated writes, on top of
 * SameSite=Lax: reject cross-site requests by Fetch Metadata, and reject an
 * Origin that is not the dashboard.
 */
export function verifyRequestOrigin(req: Request, res: Response, next: NextFunction) {
  if (!UNSAFE.has(req.method)) return next();
  // Unsubscribe links are posted by mail clients from any origin. They carry a
  // signed token and no cookie, so there is nothing for CSRF to ride on.
  if (req.path.startsWith('/unsubscribe/')) return next();
  const origin = req.get('origin');
  if (origin && origin !== env.WEB_ORIGIN) {
    return res.status(403).json({ error: 'Request origin is not allowed.' });
  }
  if (!origin && req.get('sec-fetch-site') === 'cross-site') {
    return res.status(403).json({ error: 'Cross-site request blocked.' });
  }
  next();
}

export function securityHeaders(req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  if (!req.path.startsWith('/admin/queues')) {
    res.setHeader('X-Frame-Options', 'DENY');
  }
  if (env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}
