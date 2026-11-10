import type { NextFunction, Request, Response } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { redis } from './infra.js';
import { keys } from './keys.js';

const key = new TextEncoder().encode(env.SESSION_SECRET);
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const ISSUER = 'reachinbox-api';
const AUDIENCE = 'reachinbox-web';

export const sessionCookieOptions = {
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: SESSION_TTL_SECONDS * 1000,
};

export async function issueSession(userId: string) {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setJti(randomUUID())
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(key);
}

async function verifySession(token: string) {
  const { payload } = await jwtVerify(token, key, {
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ['HS256'],
  });
  if (typeof payload.sub !== 'string' || typeof payload.jti !== 'string') {
    throw new Error('Session claims are incomplete');
  }
  return payload as typeof payload & { sub: string; jti: string };
}

/**
 * Stateless JWT sessions plus a Redis deny-list keyed by `jti`. Logout writes
 * the `jti` with a TTL equal to the token's remaining lifetime, so a copied
 * cookie stops working immediately and the deny-list cleans itself up.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.session;
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    const payload = await verifySession(token);
    if (await redis.exists(keys.revokedSession(payload.jti))) {
      throw new Error('Session revoked');
    }
    req.userId = payload.sub;
    next();
  } catch {
    res.clearCookie('session', { ...sessionCookieOptions, maxAge: undefined });
    return res.status(401).json({ error: 'Session expired' });
  }
}

export async function revokeSession(token: string | undefined): Promise<void> {
  if (!token) return;
  try {
    const payload = await verifySession(token);
    const ttl = Math.max(1, (payload.exp ?? 0) - Math.floor(Date.now() / 1000));
    await redis.set(keys.revokedSession(payload.jti), '1', 'EX', ttl);
  } catch {
    // An invalid or expired token needs no revocation.
  }
}
