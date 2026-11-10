import { logger } from './logger.js';

type Closer = { name: string; close: () => Promise<unknown> };

/**
 * Ordered graceful shutdown with a hard deadline. Stop intake first (HTTP
 * server, workers), then shared clients. A stuck closer cannot keep a pod in
 * Terminating forever; the orchestrator restarts it and reconciliation heals.
 */
export function installShutdown(
  closers: Closer[],
  deadlineMs = 25_000,
): (reason: string, exitCode?: number) => Promise<void> {
  let started = false;
  const shutdown = async (signal: string, exitCode = 0) => {
    if (started) return;
    started = true;
    logger.info({ event: 'shutdown.started', signal });
    const timer = setTimeout(() => {
      logger.error({ event: 'shutdown.timeout', deadlineMs });
      process.exit(1);
    }, deadlineMs);
    timer.unref();
    for (const closer of closers) {
      try {
        await closer.close();
      } catch (error) {
        logger.warn({ event: 'shutdown.close_failed', target: closer.name, err: error });
      }
    }
    logger.info({ event: 'shutdown.complete' });
    process.exit(exitCode);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) =>
    logger.error({ event: 'process.unhandled_rejection', err: reason }),
  );
  process.on('uncaughtException', (error) => {
    logger.fatal({ event: 'process.uncaught_exception', err: error });
    void shutdown('uncaughtException', 1);
  });
  return shutdown;
}
