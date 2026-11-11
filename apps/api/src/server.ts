import { createApp } from './app.js';
import { env } from './config/env.js';
import { closeEventStreams } from './events/stream.js';
import { elastic, prisma, redis } from './lib/infra.js';
import { installShutdown } from './lib/lifecycle.js';
import { logger } from './lib/logger.js';
import { emailQueue, searchSyncQueue } from './queues/emailQueue.js';
import { reconcileOnce, startReconcileLoop } from './services/recovery.js';
import { ensureQuotaState } from './services/quotaRecovery.js';
import { ensureSearchIndex } from './services/search.js';
import { closeTransports } from './services/transports.js';
import {
  createDeliveryWorker,
  createSearchSyncWorker,
  verifyDeliveryTransport,
} from './workers/emailWorker.js';

const app = createApp();
const server = app.listen(env.API_PORT, () => {
  logger.info({ event: 'api.listening', port: env.API_PORT });
  void (async () => {
    const searchReady =
      env.SEARCH_ENABLED &&
      (await ensureSearchIndex()
        .then(() => true)
        .catch((error) => {
          logger.warn({ event: 'search.startup_degraded', err: error });
          return false;
        }));
    if (env.RUN_WORKER)
      await ensureQuotaState().catch((e) =>
        logger.error({ event: 'quota.rebuild_failed', err: e }),
      );
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

const stopReconcileLoop = startReconcileLoop();

// Single-service hosting: the same process also delivers email. The reconcile loop above is shared.
const delivery = env.RUN_WORKER ? createDeliveryWorker() : null;
const searchSync = env.RUN_WORKER && env.SEARCH_ENABLED ? createSearchSyncWorker() : null;
if (delivery) {
  void verifyDeliveryTransport()
    .then(() => {
      void delivery.run();
      if (searchSync) void searchSync.run();
      logger.info({ event: 'api.worker_started', concurrency: env.WORKER_CONCURRENCY });
    })
    .catch((error) => logger.fatal({ event: 'api.worker_startup_failed', err: error }));
}

installShutdown([
  {
    name: 'http',
    close: async () => {
      stopReconcileLoop();
      await closeEventStreams();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  },
  // Worker.close() waits for in-flight jobs, so no send is cut off mid-way.
  { name: 'delivery-worker', close: async () => void (await delivery?.close()) },
  { name: 'search-worker', close: async () => void (await searchSync?.close()) },
  { name: 'smtp', close: async () => closeTransports() },
  { name: 'queues', close: () => Promise.all([emailQueue.close(), searchSyncQueue.close()]) },
  { name: 'postgres', close: () => prisma.$disconnect() },
  { name: 'redis', close: () => redis.quit() },
  { name: 'elasticsearch', close: () => elastic.close() },
]);
