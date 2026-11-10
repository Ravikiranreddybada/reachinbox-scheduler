import { elastic, prisma } from './lib/infra.js';
import { logger } from './lib/logger.js';
import { ensureSearchIndex, indexEmails } from './services/search.js';

/** Rebuilds the search projection from PostgreSQL, the source of truth. */
async function reindex() {
  await ensureSearchIndex();
  let cursor: string | undefined;
  let indexed = 0;
  let stale = 0;
  for (;;) {
    const rows = await prisma.email.findMany({
      take: 500,
      orderBy: { id: 'asc' },
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (!rows.length) break;
    const result = await indexEmails(rows);
    indexed += result.indexed;
    stale += result.stale;
    cursor = rows.at(-1)?.id;
    if (rows.length < 500) break;
  }
  logger.info({ event: 'search.reindexed', indexed, alreadyCurrent: stale });
}

reindex()
  .then(() => 0)
  .catch((error) => {
    logger.error({ event: 'search.reindex_failed', err: error });
    return 1;
  })
  .then(async (code) => {
    await Promise.allSettled([prisma.$disconnect(), elastic.close()]);
    process.exit(code);
  });
