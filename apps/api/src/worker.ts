import { env } from './config/env.js';
import { elastic, prisma, redis } from './lib/infra.js';
import { installShutdown } from './lib/lifecycle.js';
import { logger } from './lib/logger.js';
import { emailQueue, searchSyncQueue } from './queues/emailQueue.js';
import { ensureQuotaState } from './services/quotaRecovery.js';
import { reconcileOnce, startReconcileLoop } from './services/recovery.js';
import { ensureSearchIndex } from './services/search.js';
import { closeTransports } from './services/transports.js';
import {
  createDeliveryWorker,
  createSearchSyncWorker,
  verifyDeliveryTransport,
} from './workers/emailWorker.js';

const delivery = createDeliveryWorker();
const searchSync = createSearchSyncWorker();

const stopReconcileLoop = startReconcileLoop();

const shutdown = installShutdown([
  { name: 'reconcile-loop', close: async () => stopReconcileLoop() },
  // Worker.close() waits for in-flight jobs, so no send is cut off mid-way.
  { name: 'delivery-worker', close: () => delivery.close() },
  { name: 'search-worker', close: () => searchSync.close() },
  { name: 'queues', close: () => Promise.all([emailQueue.close(), searchSyncQueue.close()]) },
  { name: 'smtp', close: async () => closeTransports() },
  { name: 'postgres', close: () => prisma.$disconnect() },
  { name: 'redis', close: () => redis.quit() },
  { name: 'elasticsearch', close: () => elastic.close() },
]);

async function start() {
  // Fail fast on bad SMTP credentials instead of burning retries on every job.
  await verifyDeliveryTransport();
  const searchReady = await ensureSearchIndex()
    .then(() => true)
    .catch((error) => {
      logger.warn({ event: 'search.startup_degraded', err: error });
      return false;
    });
  // Hourly quotas live in Redis; rebuild them from PostgreSQL if Redis restarted empty.
  await ensureQuotaState();
  const recovery = await reconcileOnce();
  void delivery.run();
  void searchSync.run();
  logger.info({
    event: 'worker.started',
    concurrency: env.WORKER_CONCURRENCY,
    transport: env.DELIVERY_TRANSPORT,
    minSendIntervalMs: env.MIN_SEND_INTERVAL_MS,
    searchReady,
    recovery,
  });
}

start().catch((error) => {
  logger.fatal({ event: 'worker.startup_failed', err: error });
  void shutdown('startup_failed', 1);
});
