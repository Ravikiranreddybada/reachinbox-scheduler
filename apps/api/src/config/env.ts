import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const envPath = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '../../.env'),
].find(existsSync);
if (envPath) dotenv.config({ path: envPath, quiet: true });

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value?.trim() ? value.trim() : undefined));

const boolFlag = (fallback: boolean) =>
  z
    .enum(['true', 'false'])
    .default(fallback ? 'true' : 'false')
    .transform((value) => value === 'true');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().default('redis://localhost:6379'),
    ELASTICSEARCH_URL: z.string().url().default('http://localhost:9200'),
    ELASTICSEARCH_USERNAME: optionalString,
    ELASTICSEARCH_PASSWORD: optionalString,
    SESSION_SECRET: z.string().min(32),
    /** Base64 32-byte key for secrets at rest (openssl rand -base64 32). Required: no fallback. */
    DATA_ENCRYPTION_KEY: z
      .string()
      .refine((value) => Buffer.from(value.trim(), 'base64').length === 32, {
        message: 'DATA_ENCRYPTION_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32).',
      })
      .transform((value) => value.trim()),
    /** Comma-separated retired keys. They still decrypt; `pnpm rotate-secrets` re-encrypts. */
    DATA_ENCRYPTION_KEY_PREVIOUS: z
      .string()
      .default('')
      .transform((value) =>
        value
          .split(',')
          .map((key) => key.trim())
          .filter(Boolean),
      ),
    /** Public base URL of the API, used in unsubscribe links. */
    API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
    BULL_BOARD_ADMIN_EMAILS: z.string().default(''),
    /** Bearer token for /metrics. When unset, /metrics is open (local development only). */
    METRICS_TOKEN: optionalString,
    GOOGLE_CLIENT_ID: optionalString,
    GOOGLE_CLIENT_SECRET: optionalString,
    GOOGLE_CALLBACK_URL: z.string().url().default('http://localhost:4000/auth/google/callback'),
    /** `smtp` sends through Ethereal; `stream` renders messages in-process for load tests. */
    DELIVERY_TRANSPORT: z.enum(['smtp', 'stream']).default('smtp'),
    ETHEREAL_HOST: z.string().default('smtp.ethereal.email'),
    ETHEREAL_PORT: z.coerce.number().int().default(587),
    ETHEREAL_USER: optionalString,
    ETHEREAL_PASSWORD: optionalString,
    ETHEREAL_FROM_NAME: z.string().default('ReachInbox Demo'),
    /** Per-worker memory budget for attachment bytes kept between sends (LRU). */
    ATTACHMENT_CACHE_BYTES: z.coerce
      .number()
      .int()
      .min(0)
      .default(64 * 1024 * 1024),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(8),
    /** Minimum spacing between two sends from the same sender, across all workers. */
    MIN_SEND_INTERVAL_MS: z.coerce.number().int().min(0).max(3_600_000).default(2000),
    MAX_EMAILS_PER_HOUR_PER_SENDER: z.coerce.number().int().min(1).default(200),
    MAX_EMAILS_PER_HOUR_PER_TENANT: z.coerce.number().int().min(1).default(5000),
    MAX_EMAILS_PER_HOUR_GLOBAL: z.coerce.number().int().min(1).default(20000),
    /** A PROCESSING row older than this is presumed abandoned and is reclaimed. */
    PROCESSING_LEASE_MS: z.coerce.number().int().min(60_000).default(300_000),
    RECONCILE_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .default(5 * 60_000),
    /**
     * Only emails due within this window own a BullMQ delayed job. Later ones wait
     * in PostgreSQL and are queued by the reconciler as they come into range, so
     * Redis memory is bounded by the horizon, not by how far ahead people schedule.
     */
    ENQUEUE_HORIZON_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .default(6 * 3_600_000),
    /** Run the delivery worker inside the API process (single-service hosting). */
    RUN_WORKER: boolFlag(false),
    /** When false, nothing is indexed or searched and no Elasticsearch is needed. */
    SEARCH_ENABLED: boolFlag(true),
    SLACK_CLIENT_ID: optionalString,
    SLACK_CLIENT_SECRET: optionalString,
    SLACK_REDIRECT_URI: optionalString,
  })
  .superRefine((value, ctx) => {
    if (value.ENQUEUE_HORIZON_MS < value.RECONCILE_INTERVAL_MS * 2) {
      ctx.addIssue({
        code: 'custom',
        path: ['ENQUEUE_HORIZON_MS'],
        message: 'ENQUEUE_HORIZON_MS must be at least twice RECONCILE_INTERVAL_MS.',
      });
    }
    if (value.NODE_ENV === 'production' && /replace|changeme|example/i.test(value.SESSION_SECRET)) {
      ctx.addIssue({
        code: 'custom',
        path: ['SESSION_SECRET'],
        message: 'SESSION_SECRET still holds the placeholder value.',
      });
    }
  });

export const env = schema.parse(process.env);
export type Env = typeof env;
