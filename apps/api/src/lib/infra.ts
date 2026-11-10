import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { Client } from '@elastic/elasticsearch';
import { env } from '../config/env.js';

export const prisma = new PrismaClient({
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

/**
 * Elasticsearch is a projection, never on the critical path. Short timeouts
 * stop a slow cluster from holding API requests or worker slots.
 */
export const elastic = new Client({
  node: env.ELASTICSEARCH_URL,
  requestTimeout: 5_000,
  maxRetries: 1,
  ...(env.ELASTICSEARCH_USERNAME && env.ELASTICSEARCH_PASSWORD
    ? { auth: { username: env.ELASTICSEARCH_USERNAME, password: env.ELASTICSEARCH_PASSWORD } }
    : {}),
});
