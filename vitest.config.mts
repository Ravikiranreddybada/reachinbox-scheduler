import { defineConfig } from 'vitest/config';

// Each integration run migrates a fresh, uniquely named schema and drops only
// that schema afterwards, so no existing database is ever reset.
const testSchema = `it_${Date.now()}`;
const baseTestDatabase =
  process.env.TEST_DATABASE_URL ?? 'postgresql://reachinbox:reachinbox@localhost:5432/reachinbox';
process.env.INTEGRATION_DATABASE_URL = `${baseTestDatabase.split('?')[0]}?schema=${testSchema}`;
process.env.INTEGRATION_SCHEMA = testSchema;

/**
 * Two suites:
 *  - unit: pure logic with mocked infrastructure, runs anywhere in milliseconds;
 *  - integration: real PostgreSQL and Redis (docker compose), proves the
 *    concurrency claims (atomic quotas, single-winner claims, no duplicate send).
 * Integration uses its own schema and Redis DB 15, so dev data is untouched.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['apps/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', '**/node_modules/**', '**/dist/**', '**/.next/**'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['apps/**/*.int.test.ts'],
          exclude: ['**/node_modules/**'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
          globalSetup: ['apps/api/test/integration.setup.ts'],
          env: {
            NODE_ENV: 'test',
            LOG_LEVEL: 'fatal',
            DATABASE_URL: process.env.INTEGRATION_DATABASE_URL,
            REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15',
            SESSION_SECRET: 'integration-test-secret-with-32-plus-chars',
            DELIVERY_TRANSPORT: 'stream',
            MIN_SEND_INTERVAL_MS: '1000',
            MAX_EMAILS_PER_HOUR_PER_SENDER: '10',
            MAX_EMAILS_PER_HOUR_GLOBAL: '25',
            WORKER_CONCURRENCY: '8',
          },
        },
      },
    ],
  },
});
