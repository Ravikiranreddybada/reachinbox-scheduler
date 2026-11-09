import { worker, verifyDeliveryTransport } from './workers/emailWorker.js';
import { elastic, prisma, redis } from './lib/infra.js';
import { emailQueue } from './queues/emailQueue.js';
import { ensureSearchIndex } from './services/search.js';
import { reconcileDeliveryQueue } from './services/recovery.js';
void Promise.all([
  verifyDeliveryTransport(),
  ensureSearchIndex()
    .then(() => true)
    .catch((error) => {
      console.warn({ event: 'search.startup_degraded', error });
      return false;
    }),
  reconcileDeliveryQueue(),
])
  .then(async ([, searchReady, recovery]) => {
    void worker.run();
    console.info({ event: 'worker.started', searchReady, recovery });
  })
  .catch(async (error) => {
    console.error({ event: 'worker.startup_failed', code: error?.code, message: error?.message });
    await worker.close();
    await emailQueue.close();
    await prisma.$disconnect();
    await redis.quit();
    await elastic.close();
    process.exitCode = 1;
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
