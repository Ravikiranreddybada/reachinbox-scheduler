import pino from 'pino';
import { env } from '../config/env.js';

/**
 * One structured logger for every process. Events use stable dotted names
 * (`email.sent`, `quota.exhausted`) so they can become metrics and alerts
 * without parsing prose.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: {
    service:
      process.env.SERVICE_NAME ??
      (/worker/.test(process.argv[1] ?? '') ? 'reachinbox-worker' : 'reachinbox-api'),
  },
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'webhookUrl', 'accessToken'],
    censor: '[redacted]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});
