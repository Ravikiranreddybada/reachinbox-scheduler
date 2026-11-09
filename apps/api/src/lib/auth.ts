import type { Request, Response, NextFunction } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import { env } from '../config/env.js';
const key = new TextEncoder().encode(env.SESSION_SECRET);
export async function issueSession(userId: string) {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(key);
}
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.session;
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    const { payload } = await jwtVerify(token, key);
    if (typeof payload.sub !== 'string') throw new Error('Session subject is missing');
    req.userId = payload.sub;
    next();
  } catch {
    res.clearCookie('session', sessionCookieOptions);
    return res.status(401).json({ error: 'Session expired' });
  }
}
export const sessionCookieOptions = {
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};
