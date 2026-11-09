import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import path from 'node:path';
const envPath = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '../../.env'),
].find(existsSync);
if (envPath) dotenv.config({ path: envPath });
import { z } from 'zod';
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().default(4000),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  ELASTICSEARCH_URL: z.string().default('http://localhost:9200'),
  ELASTICSEARCH_USERNAME: z.string().optional(),
  ELASTICSEARCH_PASSWORD: z.string().optional(),
  SESSION_SECRET: z.string().min(32),
  BULL_BOARD_ADMIN_EMAILS: z.string().default(''),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CALLBACK_URL: z.string().default('http://localhost:4000/auth/google/callback'),
  ETHEREAL_HOST: z.string().default('smtp.ethereal.email'),
  ETHEREAL_PORT: z.coerce.number().default(587),
  ETHEREAL_USER: z.string().optional(),
  ETHEREAL_PASSWORD: z.string().optional(),
  ETHEREAL_FROM_NAME: z.string().default('ReachInbox Demo'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(8),
  MIN_SEND_INTERVAL_MS: z.coerce.number().int().min(0).default(2000),
  MAX_EMAILS_PER_HOUR_PER_SENDER: z.coerce.number().int().min(1).default(200),
  MAX_EMAILS_PER_HOUR_GLOBAL: z.coerce.number().int().min(1).default(5000),
  PROCESSING_LEASE_MS: z.coerce.number().int().min(30_000).default(300_000),
  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  SLACK_REDIRECT_URI: z.string().optional(),
});
export const env = schema.parse(process.env);
