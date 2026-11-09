import { prisma, elastic } from './lib/infra.js';
import { ensureSearchIndex } from './services/search.js';

async function reindex() {
  await ensureSearchIndex();
  let cursor: string | undefined;
  let processed = 0;
  for (;;) {
    const rows = await prisma.email.findMany({
      take: 500,
      orderBy: { id: 'asc' },
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (!rows.length) break;
    const operations = rows.flatMap((email) => [
      { index: { _index: 'emails-v1', _id: email.id } },
      {
        userId: email.userId,
        id: email.id,
        emailId: email.id,
        recipient: email.recipient,
        subject: email.subject,
        body: email.body,
        status: email.status,
        scheduledAt: email.scheduledAt,
        sentAt: email.sentAt,
      },
    ]);
    const result = await elastic.bulk({ operations, refresh: false });
    if (result.errors)
      throw new Error(`Elasticsearch rejected part of batch beginning at ${rows[0]?.id}`);
    processed += rows.length;
    cursor = rows.at(-1)?.id;
    if (rows.length < 500) break;
  }
  console.info(`Indexed ${processed} email records.`);
}
void reindex()
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
