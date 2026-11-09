import { worker } from './workers/emailWorker.js';
import { elastic, prisma, redis } from './lib/infra.js';
import { emailQueue } from './queues/emailQueue.js';
import { ensureSearchIndex } from './services/search.js';
import { reconcileDeliveryQueue } from './services/recovery.js';
void Promise.all([
  ensureSearchIndex()
    .then(() => true)
    .catch((error) => {
      console.warn({ event: 'search.startup_degraded', error });
      return false;
    }),
  reconcileDeliveryQueue(),
])
  .then(([searchReady, recovery]) =>
    console.info({ event: 'worker.started', searchReady, recovery }),
  )
  .catch((error) => {
    console.error('Worker startup failed', error);
    process.exit(1);
  });
async function shutdown() {
  await worker.close();
  await emailQueue.close();
  await prisma.$disconnect();
  await redis.quit();
  await elastic.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
