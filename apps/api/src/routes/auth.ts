import { Router } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { asyncHandler } from '../http/asyncHandler.js';
import { HttpError } from '../http/errors.js';
import { redisRateLimit } from '../http/rateLimit.js';
import { issueSession, requireAuth, revokeSession, sessionCookieOptions } from '../lib/auth.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { prisma } from '../lib/infra.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { z } from 'zod';
import { logger } from '../lib/logger.js';

const router = Router();
const key = new TextEncoder().encode(env.SESSION_SECRET);
const OAUTH_STATE_TTL = '10m';
const slackRedirect =
  env.SLACK_REDIRECT_URI || `http://localhost:${env.API_PORT}/auth/slack/callback`;

interface SlackOAuthResponse {
  ok: boolean;
  error?: string;
  team?: { id?: string; name?: string };
  incoming_webhook?: { url?: string; channel?: string; channel_id?: string };
  access_token?: string;
}

const google =
  env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
    ? new OAuth2Client(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_CALLBACK_URL)
    : null;

function signState(claims: Record<string, string>) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(OAUTH_STATE_TTL)
    .sign(key);
}

/** OAuth failures land back on the dashboard with a reason instead of a bare text page. */
function backToApp(params: Record<string, string>) {
  return `${env.WEB_ORIGIN}/?${new URLSearchParams(params).toString()}`;
}

router.get(
  '/google',
  asyncHandler(async (_req, res) => {
    if (!google) {
      return res.redirect(
        backToApp({
          auth_error:
            'Google sign-in is not configured yet. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or use email and password.',
        }),
      );
    }
    const nonce = randomUUID();
    const state = await signState({ intent: 'google-login', nonce });
    // The nonce cookie binds the state to this browser (login CSRF protection).
    res.cookie('google_oauth_nonce', nonce, { ...sessionCookieOptions, maxAge: 10 * 60 * 1000 });
    res.redirect(
      google.generateAuthUrl({
        access_type: 'online',
        scope: ['openid', 'email', 'profile'],
        state,
        prompt: 'select_account',
      }),
    );
  }),
);

router.get('/google/callback', async (req, res) => {
  res.clearCookie('google_oauth_nonce', { ...sessionCookieOptions, maxAge: undefined });
  try {
    if (!google || typeof req.query.code !== 'string' || typeof req.query.state !== 'string') {
      throw new Error('Invalid OAuth callback');
    }
    const { payload } = await jwtVerify(req.query.state, key);
    if (
      payload.intent !== 'google-login' ||
      typeof payload.nonce !== 'string' ||
      payload.nonce !== req.cookies?.google_oauth_nonce
    ) {
      throw new Error('Invalid OAuth state');
    }
    const { tokens } = await google.getToken(req.query.code);
    if (!tokens.id_token) throw new Error('Google did not return an ID token');
    const ticket = await google.verifyIdToken({
      idToken: tokens.id_token,
      audience: env.GOOGLE_CLIENT_ID,
    });
    const profile = ticket.getPayload();
    if (!profile?.sub || !profile.email || !profile.email_verified) {
      throw new Error('Google account email is missing or not verified');
    }
    const name = profile.name || profile.email.split('@')[0]!;
    const email = profile.email.toLowerCase();
    const existing = await prisma.user.findFirst({
      where: { OR: [{ googleId: profile.sub }, { email }] },
      select: { id: true },
    });
    const user = existing
      ? await prisma.user.update({
          where: { id: existing.id },
          data: { googleId: profile.sub, avatarUrl: profile.picture, name },
        })
      : await prisma.user.create({
          data: { googleId: profile.sub, email, name, avatarUrl: profile.picture },
        });
    logger.info({ event: 'auth.login', userId: user.id });
    res
      .cookie('session', await issueSession(user.id), sessionCookieOptions)
      .redirect(`${env.WEB_ORIGIN}/`);
  } catch (error) {
    logger.warn({ event: 'auth.login_failed', err: error });
    res.redirect(backToApp({ auth_error: 'Google sign-in failed. Please try again.' }));
  }
});

const credentials = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8, 'Password must be at least 8 characters.').max(200),
});

/**
 * Email + password sign-in, with sign-up through the same form (the design has
 * one form for both). An unknown address creates the account; a known address
 * must match its password. Failures use one message so the endpoint does not
 * reveal which addresses are registered.
 */
router.post(
  '/login',
  redisRateLimit({
    bucket: 'login',
    limit: 10,
    windowMs: 60_000,
    subject: (req) => req.ip ?? 'ip',
  }),
  asyncHandler(async (req, res) => {
    const parsed = credentials.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        parsed.error.issues[0]?.message ?? 'Enter a valid email and password.',
      );
    }
    const { email, password } = parsed.data;
    let user = await prisma.user.findUnique({ where: { email } });
    let created = false;
    if (!user) {
      user = await prisma.user.create({
        data: {
          email,
          name: email.split('@')[0]!.replace(/[._-]+/g, ' '),
          passwordHash: await hashPassword(password),
        },
      });
      created = true;
    } else if (!user.passwordHash) {
      // Google-only account: the first password sign-in sets the password only
      // if the caller proves control through Google, so refuse here.
      throw new HttpError(401, 'This account uses Google sign-in. Use "Login with Google".');
    } else if (!(await verifyPassword(password, user.passwordHash))) {
      throw new HttpError(401, 'Incorrect email or password.');
    }
    logger.info({ event: created ? 'auth.signup' : 'auth.login', userId: user.id });
    res
      .cookie('session', await issueSession(user.id), sessionCookieOptions)
      .status(created ? 201 : 200)
      .json({ created });
  }),
);

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: {
        id: true,
        email: true,
        name: true,
        avatarUrl: true,
        slackConnection: { select: { teamName: true, channelName: true, connectedAt: true } },
      },
    });
    if (!user) return res.status(401).json({ error: 'User not found' });
    res.json({ user });
  }),
);

router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    await revokeSession(req.cookies?.session);
    res
      .clearCookie('session', { ...sessionCookieOptions, maxAge: undefined })
      .status(204)
      .end();
  }),
);

router.get(
  '/slack',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) {
      return res.status(503).json({ error: 'Slack OAuth is not configured' });
    }
    const state = await signState({ intent: 'slack-connect', userId: req.userId! });
    const url = new URL('https://slack.com/oauth/v2/authorize');
    url.search = new URLSearchParams({
      client_id: env.SLACK_CLIENT_ID,
      scope: 'incoming-webhook',
      redirect_uri: slackRedirect,
      state,
    }).toString();
    res.redirect(url.toString());
  }),
);

router.get('/slack/callback', requireAuth, async (req, res) => {
  try {
    if (typeof req.query.error === 'string') throw new Error(req.query.error);
    if (typeof req.query.code !== 'string' || typeof req.query.state !== 'string') {
      throw new Error('Invalid Slack callback');
    }
    const { payload } = await jwtVerify(req.query.state, key);
    if (payload.intent !== 'slack-connect' || payload.userId !== req.userId) {
      throw new Error('Invalid OAuth state');
    }
    const response = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: req.query.code,
        client_id: env.SLACK_CLIENT_ID!,
        client_secret: env.SLACK_CLIENT_SECRET!,
        redirect_uri: slackRedirect,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const result = (await response.json()) as SlackOAuthResponse;
    const webhook = result.incoming_webhook;
    if (!result.ok || !webhook?.url) {
      throw new Error(result.error || 'Slack did not grant an incoming webhook');
    }
    const record = {
      teamId: result.team?.id ?? 'unknown',
      teamName: result.team?.name,
      channelName: webhook.channel,
      webhookUrl: encryptSecret(webhook.url),
      accessToken: result.access_token ? encryptSecret(result.access_token) : null,
    };
    await prisma.slackConnection.upsert({
      where: { userId: req.userId! },
      update: { ...record, connectedAt: new Date() },
      create: { userId: req.userId!, ...record },
    });
    logger.info({ event: 'slack.connected', userId: req.userId, teamId: record.teamId });
    res.redirect(backToApp({ slack: 'connected' }));
  } catch (error) {
    logger.warn({ event: 'slack.connect_failed', userId: req.userId, err: error });
    res.redirect(backToApp({ slack_error: 'Slack connection failed. Please try again.' }));
  }
});

router.delete(
  '/slack',
  requireAuth,
  asyncHandler(async (req, res) => {
    const connection = await prisma.slackConnection.findUnique({ where: { userId: req.userId! } });
    if (connection?.accessToken) {
      // Revoking the token also disables the incoming webhook it created. A
      // revoke failure must not trap the user: the local record is removed
      // either way, so no further notifications are sent.
      try {
        const response = await fetch('https://slack.com/api/auth.revoke', {
          method: 'POST',
          headers: { Authorization: `Bearer ${decryptSecret(connection.accessToken)}` },
          signal: AbortSignal.timeout(10_000),
        });
        const result = (await response.json()) as { ok?: boolean; error?: string };
        if (!result.ok) logger.warn({ event: 'slack.revoke_failed', reason: result.error });
      } catch (error) {
        logger.warn({ event: 'slack.revoke_failed', err: error });
      }
    }
    await prisma.slackConnection.deleteMany({ where: { userId: req.userId! } });
    logger.info({ event: 'slack.disconnected', userId: req.userId });
    res.status(204).end();
  }),
);

export default router;
