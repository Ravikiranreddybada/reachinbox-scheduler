import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { createBullBoard } from '@bull-board/api';
import { ExpressAdapter } from '@bull-board/express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import { randomUUID } from 'node:crypto';
import pinoHttp from 'pino-http';
import { env } from './config/env.js';
import { streamEvents } from './events/stream.js';
import { asyncHandler } from './http/asyncHandler.js';
import { errorHandler, notFound } from './http/errors.js';
import { redisRateLimit } from './http/rateLimit.js';
import { securityHeaders, verifyRequestOrigin } from './http/security.js';
import { requireAuth } from './lib/auth.js';
import { elastic, prisma, redis } from './lib/infra.js';
import { logger } from './lib/logger.js';
import { renderMetrics } from './observability/prometheus.js';
import { emailQueue, searchSyncQueue } from './queues/emailQueue.js';
import attachmentRoutes from './routes/attachments.js';
import authRoutes from './routes/auth.js';
import campaignRoutes from './routes/campaigns.js';
import emailRoutes from './routes/emails.js';

/** Builds the HTTP application without binding a port, so tests can mount it. */
export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && incoming.length <= 128 ? incoming : randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
    }),
  );
  app.use(securityHeaders);
  app.use(cors({ origin: env.WEB_ORIGIN, credentials: true, exposedHeaders: ['X-Request-Id'] }));
  // 5,000 recipients x 254 bytes plus a 100 KB body fit comfortably in 2 MB.
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  app.use(verifyRequestOrigin);

  app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
  app.get(
    '/health',
    asyncHandler(async (_req, res) => {
      const timed = async (check: () => Promise<unknown>) => {
        const started = performance.now();
        try {
          await Promise.race([
            check(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2_000)),
          ]);
          return { status: 'ok', latencyMs: Math.round(performance.now() - started) };
        } catch {
          return { status: 'error', latencyMs: Math.round(performance.now() - started) };
        }
      };
      const [database, cache, search] = await Promise.all([
        timed(() => prisma.$queryRaw`SELECT 1`),
        timed(() => redis.ping()),
        timed(() => elastic.ping()),
      ]);
      // Search is a projection: its outage degrades the service but does not stop delivery.
      const ready = database.status === 'ok' && cache.status === 'ok';
      res.status(ready ? 200 : 503).json({
        status: ready ? (search.status === 'ok' ? 'ok' : 'degraded') : 'unavailable',
        checks: { database, redis: cache, search },
      });
    }),
  );

  app.get(
    '/metrics',
    asyncHandler(async (req, res) => {
      if (env.METRICS_TOKEN && req.get('authorization') !== `Bearer ${env.METRICS_TOKEN}`) {
        return res.status(401).end();
      }
      res.type('text/plain; version=0.0.4').send(await renderMetrics());
    }),
  );

  const perUser = (req: express.Request) => req.userId ?? req.ip ?? 'anonymous';
  // Strict per-IP limit on OAuth entry points; a generous one for session reads,
  // which the dashboard calls on every refresh.
  app.use(
    ['/auth/google', '/auth/slack'],
    redisRateLimit({
      bucket: 'oauth',
      limit: 30,
      windowMs: 60_000,
      subject: (req) => req.ip ?? 'ip',
    }),
  );
  app.use(
    '/auth',
    redisRateLimit({
      bucket: 'auth',
      limit: 600,
      windowMs: 60_000,
      subject: (req) => req.ip ?? 'ip',
    }),
    authRoutes,
  );
  app.get('/api/events', requireAuth, streamEvents);
  app.use(
    '/api/emails',
    requireAuth,
    redisRateLimit({ bucket: 'emails', limit: 240, windowMs: 60_000, subject: perUser }),
    emailRoutes,
  );
  app.use(
    '/api/attachments',
    requireAuth,
    redisRateLimit({ bucket: 'attachments', limit: 60, windowMs: 60_000, subject: perUser }),
    attachmentRoutes,
  );
  // Addresses this user has sent from, for the compose "From" picker.
  app.get(
    '/api/senders',
    requireAuth,
    asyncHandler(async (req, res) => {
      const senders = await prisma.sender.findMany({
        where: { userId: req.userId! },
        select: { email: true, displayName: true },
        orderBy: { createdAt: 'asc' },
        take: 50,
      });
      res.json({ items: senders });
    }),
  );
  // Effective delivery policy, so the dashboard shows real limits, not marketing copy.
  app.get('/api/settings', requireAuth, (_req, res) => {
    res.json({
      minSendIntervalMs: env.MIN_SEND_INTERVAL_MS,
      maxEmailsPerHourPerSender: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
      maxEmailsPerHourPerWorkspace: env.MAX_EMAILS_PER_HOUR_PER_TENANT,
      maxEmailsPerHourGlobal: env.MAX_EMAILS_PER_HOUR_GLOBAL,
      workerConcurrency: env.WORKER_CONCURRENCY,
      maxAttempts: 5,
      deliveryTransport: env.DELIVERY_TRANSPORT,
    });
  });
  app.use(
    '/api/campaigns',
    requireAuth,
    redisRateLimit({ bucket: 'campaigns', limit: 120, windowMs: 60_000, subject: perUser }),
    campaignRoutes,
  );

  const boardAdapter = new ExpressAdapter();
  boardAdapter.setBasePath('/admin/queues');
  createBullBoard({
    queues: [new BullMQAdapter(emailQueue), new BullMQAdapter(searchSyncQueue)],
    serverAdapter: boardAdapter,
  });
  const operatorEmails = new Set(
    env.BULL_BOARD_ADMIN_EMAILS.split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
  app.use(
    '/admin/queues',
    requireAuth,
    asyncHandler(async (req, res, next) => {
      const user = await prisma.user.findUnique({
        where: { id: req.userId! },
        select: { email: true },
      });
      if (!user || !operatorEmails.has(user.email.toLowerCase())) {
        return res.status(403).send('Queue dashboard access is limited to configured operators.');
      }
      next();
    }),
    boardAdapter.getRouter(),
  );

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
