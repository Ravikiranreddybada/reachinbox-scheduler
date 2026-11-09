import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { createBullBoard } from '@bull-board/api';
import { ExpressAdapter } from '@bull-board/express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { ZodError } from 'zod';
import { env } from './config/env.js';
import { requireAuth } from './lib/auth.js';
import { elastic, prisma, redis } from './lib/infra.js';
import { emailQueue } from './queues/emailQueue.js';
import authRoutes from './routes/auth.js';
import emailRoutes from './routes/emails.js';
import { reconcileDeliveryQueue } from './services/recovery.js';
import { ensureSearchIndex } from './services/search.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(pinoHttp({ redact: ['req.headers.authorization', 'req.headers.cookie'] }));
app.use(cors({ origin: env.WEB_ORIGIN, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const origin = req.get('origin');
    if (origin && origin !== env.WEB_ORIGIN) {
      return res.status(403).json({ error: 'Request origin is not allowed.' });
    }
  }
  next();
});

app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
app.get('/health', async (_req, res) => {
  const checks = { database: 'unknown', redis: 'unknown', search: 'unknown' };
  await Promise.all([
    prisma.$queryRaw`SELECT 1`
      .then(() => (checks.database = 'ok'))
      .catch(() => (checks.database = 'error')),
    redis
      .ping()
      .then(() => (checks.redis = 'ok'))
      .catch(() => (checks.redis = 'error')),
    elastic
      .ping()
      .then(() => (checks.search = 'ok'))
      .catch(() => (checks.search = 'error')),
  ]);
  const healthy = checks.database === 'ok' && checks.redis === 'ok';
  res.status(healthy ? 200 : 503).json({
    status: healthy ? (checks.search === 'ok' ? 'ok' : 'degraded') : 'unavailable',
    checks,
  });
});

app.use(
  '/auth',
  rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false }),
  authRoutes,
);
app.use(
  '/api/emails',
  requireAuth,
  rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }),
  emailRoutes,
);

const boardAdapter = new ExpressAdapter();
boardAdapter.setBasePath('/admin/queues');
createBullBoard({ queues: [new BullMQAdapter(emailQueue)], serverAdapter: boardAdapter });
app.use(
  '/admin/queues',
  requireAuth,
  async (req, res, next) => {
    const user = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { email: true },
    });
    const admins = env.BULL_BOARD_ADMIN_EMAILS.split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean);
    if (!user || !admins.includes(user.email.toLowerCase())) {
      return res.status(403).send('Queue dashboard access is limited to configured operators.');
    }
    next();
  },
  boardAdapter.getRouter(),
);

app.use(
  (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: error.issues });
    }
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  },
);

const server = app.listen(env.API_PORT, async () => {
  try {
    const searchReady = await ensureSearchIndex()
      .then(() => true)
      .catch((error) => {
        console.warn({ event: 'search.startup_degraded', error });
        return false;
      });
    const recovery = await reconcileDeliveryQueue();
    console.info({ event: 'api.started', port: env.API_PORT, searchReady, recovery });
  } catch (error) {
    console.error({ event: 'startup.degraded', error });
  }
});

const recoveryTimer = setInterval(() => {
  void reconcileDeliveryQueue().catch((error) =>
    console.error({ event: 'recovery.failed', error }),
  );
}, 5 * 60_000);
recoveryTimer.unref();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(recoveryTimer);
  console.info({ event: 'shutdown.started', signal });
  server.close();
  await emailQueue.close();
  await prisma.$disconnect();
  await redis.quit();
  await elastic.close();
  console.info({ event: 'shutdown.complete' });
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
