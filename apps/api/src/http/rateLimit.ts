import type { NextFunction, Request, Response } from 'express';
import { keys } from '../lib/keys.js';
import { redis } from '../lib/infra.js';
import { logger } from '../lib/logger.js';

/**
 * Fixed-window HTTP rate limiter backed by Redis, so the limit holds across
 * every API replica (an in-memory limiter multiplies the limit by the replica
 * count). Fails open when Redis is unreachable: availability of the API beats
 * strict abuse protection, and the write path needs Redis anyway.
 */
export function redisRateLimit(options: {
  bucket: string;
  limit: number;
  windowMs: number;
  subject: (req: Request) => string;
}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const window = Math.floor(Date.now() / options.windowMs);
    const key = keys.httpRate(options.bucket, options.subject(req), window);
    try {
      const [[, count]] = (await redis.multi().incr(key).pexpire(key, options.windowMs).exec()) as [
        [null, number],
        [null, number],
      ];
      const resetSeconds = Math.ceil(((window + 1) * options.windowMs - Date.now()) / 1000);
      res.setHeader('RateLimit-Limit', options.limit);
      res.setHeader('RateLimit-Remaining', Math.max(0, options.limit - count));
      res.setHeader('RateLimit-Reset', resetSeconds);
      if (count > options.limit) {
        res.setHeader('Retry-After', resetSeconds);
        return res.status(429).json({ error: 'Too many requests. Retry later.' });
      }
    } catch (error) {
      logger.warn({ event: 'http.rate_limit_unavailable', err: error });
    }
    next();
  };
}
