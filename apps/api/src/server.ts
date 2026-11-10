import { createApp } from './app.js';
import { env } from './config/env.js';
import { closeEventStreams } from './events/stream.js';
import { elastic, prisma, redis } from './lib/infra.js';
import { installShutdown } from './lib/lifecycle.js';
import { logger } from './lib/logger.js';
import { emailQueue, searchSyncQueue } from './queues/emailQueue.js';
import { reconcileOnce } from './services/recovery.js';
import { ensureSearchIndex } from './services/search.js';

const app = createApp();
const server = app.listen(env.API_PORT, () => {
  logger.info({ event: 'api.listening', port: env.API_PORT });
  void (async () => {
    const searchReady = await ensureSearchIndex()
      .then(() => true)
      .catch((error) => {
        logger.warn({ event: 'search.startup_degraded', err: error });
        return false;
      });
    const recovery = await reconcileOnce().catch((error) => {
      logger.error({ event: 'recovery.failed', err: error });
      return null;
    });
    logger.info({ event: 'api.started', searchReady, recovery });
  })();
});
// Longer than a typical load balancer idle timeout, so the LB closes first.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

const recoveryTimer = setInterval(() => {
  void reconcileOnce().catch((error) => logger.error({ event: 'recovery.failed', err: error }));
}, env.RECONCILE_INTERVAL_MS);
recoveryTimer.unref();

installShutdown([
  {
    name: 'http',
    close: async () => {
      clearInterval(recoveryTimer);
      await closeEventStreams();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  },
  { name: 'queues', close: () => Promise.all([emailQueue.close(), searchSyncQueue.close()]) },
  { name: 'postgres', close: () => prisma.$disconnect() },
  { name: 'redis', close: () => redis.quit() },
  { name: 'elasticsearch', close: () => elastic.close() },
]);
