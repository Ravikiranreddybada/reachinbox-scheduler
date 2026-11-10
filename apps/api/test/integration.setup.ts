import { PrismaClient } from '@prisma/client';
import { execSync } from 'node:child_process';
import path from 'node:path';

/**
 * Applies the committed migrations to a fresh schema exactly as production
 * does (`migrate deploy`), and drops that one schema after the run.
 */
export default async function setup() {
  const url = process.env.INTEGRATION_DATABASE_URL!;
  const schema = process.env.INTEGRATION_SCHEMA!;
  if (!/^it_\d+$/.test(schema)) throw new Error(`Refusing to use schema "${schema}"`);
  execSync('npx prisma migrate deploy --schema prisma/schema.prisma', {
    // Vitest runs global setup from the repository root.
    cwd: path.resolve(process.cwd(), 'apps/api'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
  return async () => {
    const prisma = new PrismaClient({ datasourceUrl: url });
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await prisma.$disconnect();
  };
}
