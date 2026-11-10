import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

const sign = (emailId: string) =>
  createHmac('sha256', env.SESSION_SECRET)
    .update(`unsubscribe:${emailId}`)
    .digest('base64url')
    .slice(0, 32);

/** Opaque, tamper-proof link token for one email. It grants nothing except unsubscribing. */
export function unsubscribeToken(emailId: string): string {
  return `${emailId}.${sign(emailId)}`;
}

/** Returns the email ID when the token is genuine, otherwise null. */
export function verifyUnsubscribeToken(token: string): string | null {
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const emailId = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(emailId));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return emailId;
}

export function unsubscribeUrl(emailId: string): string {
  return `${env.API_PUBLIC_URL}/unsubscribe/${unsubscribeToken(emailId)}`;
}
