import { Router } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { prisma } from '../lib/infra.js';
import { issueSession, requireAuth, sessionCookieOptions } from '../lib/auth.js';
const router = Router();
const key = new TextEncoder().encode(env.SESSION_SECRET);
interface SlackOAuthResponse {
  ok: boolean;
  error?: string;
  team?: { name?: string };
  incoming_webhook?: { url?: string; channel_id?: string };
  access_token?: string;
}
const google =
  env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
    ? new OAuth2Client(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_CALLBACK_URL)
    : null;
router.get('/google', async (_req, res) => {
  if (!google)
    return res
      .status(503)
      .send('Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
  const nonce = randomUUID();
  const state = await new SignJWT({ intent: 'google-login', nonce })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(key);
  res.cookie('google_oauth_nonce', nonce, {
    ...sessionCookieOptions,
    maxAge: 10 * 60 * 1000,
  });
  res.redirect(
    google.generateAuthUrl({
      access_type: 'online',
      scope: ['openid', 'email', 'profile'],
      state,
      prompt: 'select_account',
    }),
  );
});
router.get('/google/callback', async (req, res) => {
  try {
    if (!google || typeof req.query.code !== 'string' || typeof req.query.state !== 'string')
      throw new Error('Invalid OAuth callback');
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
    const p = ticket.getPayload();
    if (!p?.sub || !p.email || !p.name) throw new Error('Google profile is incomplete');
    const user = await prisma.user.upsert({
      where: { googleId: p.sub },
      update: { email: p.email, name: p.name, avatarUrl: p.picture },
      create: { googleId: p.sub, email: p.email, name: p.name, avatarUrl: p.picture },
    });
    res
      .clearCookie('google_oauth_nonce', { path: '/' })
      .cookie('session', await issueSession(user.id), sessionCookieOptions)
      .redirect(`${env.WEB_ORIGIN}/`);
  } catch (error) {
    res
      .clearCookie('google_oauth_nonce', { path: '/' })
      .status(401)
      .type('text/plain')
      .send(`Google sign-in failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
});
router.get('/me', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId! },
    select: {
      id: true,
      email: true,
      name: true,
      avatarUrl: true,
      slackConnection: { select: { teamName: true, connectedAt: true } },
    },
  });
  if (!user) return res.status(401).json({ error: 'User not found' });
  res.json({ user });
});
router.post('/logout', (_req, res) => res.clearCookie('session', { path: '/' }).status(204).end());
router.get('/slack', requireAuth, async (req, res) => {
  if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET)
    return res.status(503).json({ error: 'Slack OAuth is not configured' });
  const state = await new SignJWT({ intent: 'slack-connect', userId: req.userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(key);
  const redirect = env.SLACK_REDIRECT_URI || `http://localhost:${env.API_PORT}/auth/slack/callback`;
  res.redirect(
    `https://slack.com/oauth/v2/authorize?client_id=${encodeURIComponent(env.SLACK_CLIENT_ID)}&scope=incoming-webhook&redirect_uri=${encodeURIComponent(redirect)}&state=${state}`,
  );
});
router.get('/slack/callback', requireAuth, async (req, res) => {
  try {
    if (typeof req.query.code !== 'string' || typeof req.query.state !== 'string')
      throw new Error('Invalid Slack callback');
    const { payload } = await jwtVerify(req.query.state, key);
    if (payload.intent !== 'slack-connect' || payload.userId !== req.userId)
      throw new Error('Invalid OAuth state');
    const redirect =
      env.SLACK_REDIRECT_URI || `http://localhost:${env.API_PORT}/auth/slack/callback`;
    const body = new URLSearchParams({
      code: req.query.code,
      client_id: env.SLACK_CLIENT_ID!,
      client_secret: env.SLACK_CLIENT_SECRET!,
      redirect_uri: redirect,
    });
    const response = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const result = (await response.json()) as SlackOAuthResponse;
    if (!result.ok || !result.incoming_webhook?.url || !result.incoming_webhook.channel_id)
      throw new Error(result.error || 'Slack did not grant an incoming webhook');
    await prisma.slackConnection.upsert({
      where: { userId: req.userId },
      update: {
        teamId: result.incoming_webhook.channel_id,
        teamName: result.team?.name,
        webhookUrl: result.incoming_webhook.url,
        accessToken: result.access_token,
      },
      create: {
        userId: req.userId!,
        teamId: result.incoming_webhook.channel_id,
        teamName: result.team?.name,
        webhookUrl: result.incoming_webhook.url,
        accessToken: result.access_token,
      },
    });
    res.redirect(`${env.WEB_ORIGIN}/?slack=connected`);
  } catch (error) {
    res
      .status(400)
      .type('text/plain')
      .send(`Slack connection failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
});
router.delete('/slack', requireAuth, async (req, res) => {
  const connection = await prisma.slackConnection.findUnique({ where: { userId: req.userId! } });
  if (connection?.accessToken) {
    const response = await fetch('https://slack.com/api/auth.revoke', {
      method: 'POST',
      headers: { Authorization: `Bearer ${connection.accessToken}` },
    });
    const result = (await response.json()) as { ok?: boolean; error?: string };
    if (!response.ok || !result.ok) {
      return res.status(502).json({
        error: `Slack could not be disconnected${result.error ? `: ${result.error}` : '.'}`,
      });
    }
  }
  await prisma.slackConnection.deleteMany({ where: { userId: req.userId! } });
  res.status(204).end();
});
export default router;
