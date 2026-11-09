import { elastic } from '../lib/infra.js';
import type { Email } from '@prisma/client';
const INDEX = 'emails-v1';
export async function ensureSearchIndex() {
  if (!(await elastic.indices.exists({ index: INDEX })))
    await elastic.indices.create({
      index: INDEX,
      mappings: {
        properties: {
          userId: { type: 'keyword' },
          id: { type: 'keyword' },
          emailId: { type: 'keyword' },
          recipient: { type: 'text' },
          subject: { type: 'text' },
          body: { type: 'text' },
          status: { type: 'keyword' },
          scheduledAt: { type: 'date' },
          sentAt: { type: 'date' },
        },
      },
    });
}
export async function indexEmail(e: Email) {
  await elastic.index({
    index: INDEX,
    id: e.id,
    document: {
      userId: e.userId,
      id: e.id,
      emailId: e.id,
      recipient: e.recipient,
      subject: e.subject,
      body: e.body,
      status: e.status,
      scheduledAt: e.scheduledAt,
      sentAt: e.sentAt,
    },
  });
}
export async function searchEmails(userId: string, q: string, statuses?: string[]) {
  if (!q.trim()) return [];
  const r = await elastic.search({
    index: INDEX,
    size: 100,
    query: {
      bool: {
        filter: [
          { term: { userId } },
          ...(statuses?.length ? [{ terms: { status: statuses } }] : []),
        ],
        must: [
          {
            multi_match: {
              query: q,
              fields: ['recipient', 'subject', 'body'],
              type: 'best_fields',
            },
          },
        ],
      },
    },
  });
  return r.hits.hits.flatMap((hit) => (hit._source ? [hit._source] : []));
}
