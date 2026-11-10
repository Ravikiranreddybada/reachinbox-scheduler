import type { Email } from '@prisma/client';
import { elastic, prisma } from '../lib/infra.js';
import { htmlToText } from '../lib/html.js';
import { logger } from '../lib/logger.js';

/**
 * Reads and writes go through the `emails` alias. A mapping change creates
 * `emails-v3`, backfills it with `pnpm reindex`, and flips the alias with no
 * search downtime.
 */
export const SEARCH_ALIAS = 'emails';
export const SEARCH_INDEX = 'emails-v2';

export async function ensureSearchIndex(): Promise<void> {
  if (await elastic.indices.exists({ index: SEARCH_INDEX })) return;
  await elastic.indices.create({
    index: SEARCH_INDEX,
    settings: {
      analysis: {
        analyzer: {
          // `alice.smith@acme.io` -> alice, smith, acme, io, plus the full address.
          email_parts: { type: 'custom', tokenizer: 'email_tokens', filter: ['lowercase'] },
        },
        tokenizer: { email_tokens: { type: 'pattern', pattern: '[@._+\\-\\s]+' } },
      },
    },
    mappings: {
      dynamic: 'strict',
      properties: {
        userId: { type: 'keyword' },
        campaignId: { type: 'keyword' },
        recipient: {
          type: 'text',
          analyzer: 'email_parts',
          fields: { exact: { type: 'keyword' }, prefix: { type: 'search_as_you_type' } },
        },
        subject: { type: 'text', fields: { prefix: { type: 'search_as_you_type' } } },
        body: { type: 'text' },
        status: { type: 'keyword' },
        scheduledAt: { type: 'date' },
        sentAt: { type: 'date' },
        updatedAt: { type: 'date' },
      },
    },
    aliases: { [SEARCH_ALIAS]: {} },
  });
}

/** Load rows with the campaign body: new rows keep their body on the campaign only. */
export const withCampaignBody = { campaign: { select: { body: true } } } as const;

type IndexableEmail = Pick<
  Email,
  | 'id'
  | 'userId'
  | 'campaignId'
  | 'recipient'
  | 'subject'
  | 'body'
  | 'status'
  | 'scheduledAt'
  | 'sentAt'
  | 'updatedAt'
> & { campaign: { body: string | null } };

function toDocument(email: IndexableEmail) {
  return {
    userId: email.userId,
    campaignId: email.campaignId,
    recipient: email.recipient,
    subject: email.subject,
    body: htmlToText(email.body ?? email.campaign.body ?? ''),
    status: email.status,
    scheduledAt: email.scheduledAt,
    sentAt: email.sentAt,
    updatedAt: email.updatedAt,
  };
}

/**
 * Bulk-indexes rows using `updatedAt` as an external version. Elasticsearch
 * rejects a write older than the stored document (409), so out-of-order
 * updates from concurrent workers can never leave a stale status behind.
 */
export async function indexEmails(
  emails: IndexableEmail[],
): Promise<{ indexed: number; stale: number }> {
  if (!emails.length) return { indexed: 0, stale: 0 };
  const result = await elastic.bulk({
    operations: emails.flatMap((email) => [
      {
        index: {
          _index: SEARCH_ALIAS,
          _id: email.id,
          version: email.updatedAt.getTime(),
          version_type: 'external_gte' as const,
        },
      },
      toDocument(email),
    ]),
  });
  let stale = 0;
  const failures = result.items.filter((item) => {
    const status = item.index?.status ?? 500;
    if (status === 409) stale += 1;
    return status >= 300 && status !== 409;
  });
  if (failures.length) {
    throw new Error(`Elasticsearch rejected ${failures.length} of ${emails.length} documents`);
  }
  return { indexed: emails.length - stale, stale };
}

/** State-based sync: always index the current PostgreSQL row, never an event payload. */
export async function syncEmailsById(emailIds: string[]): Promise<void> {
  const rows = await prisma.email.findMany({
    where: { id: { in: emailIds } },
    include: withCampaignBody,
  });
  const result = await indexEmails(rows);
  // Rows deleted in PostgreSQL (for example a deleted account) leave the projection too.
  const found = new Set(rows.map((row) => row.id));
  const removed = emailIds.filter((id) => !found.has(id));
  if (removed.length) {
    await elastic.bulk({
      operations: removed.map((id) => ({ delete: { _index: SEARCH_ALIAS, _id: id } })),
    });
  }
  logger.debug({ event: 'search.synced', ...result, removed: removed.length });
}

export interface SearchHit {
  id: string;
  campaignId: string;
  recipient: string;
  subject: string;
  preview: string;
  status: Email['status'];
  scheduledAt: string;
  sentAt: string | null;
  score: number | null;
}

export async function searchEmails(
  userId: string,
  q: string,
  statuses?: string[],
  size = 50,
): Promise<{ items: SearchHit[]; total: number }> {
  if (!q.trim()) return { items: [], total: 0 };
  const response = await elastic.search<ReturnType<typeof toDocument>>({
    index: SEARCH_ALIAS,
    size,
    track_total_hits: true,
    _source: { excludes: ['body'] },
    query: {
      bool: {
        // Tenant isolation is a filter, not a scoring clause: it is cached and cannot be outscored.
        filter: [
          { term: { userId } },
          ...(statuses?.length ? [{ terms: { status: statuses } }] : []),
        ],
        should: [
          { term: { 'recipient.exact': { value: q.trim().toLowerCase(), boost: 10 } } },
          {
            multi_match: {
              query: q,
              type: 'bool_prefix',
              fields: [
                'recipient.prefix^3',
                'recipient.prefix._2gram',
                'recipient.prefix._3gram',
                'subject.prefix^2',
                'subject.prefix._2gram',
                'subject.prefix._3gram',
              ],
            },
          },
          {
            multi_match: {
              query: q,
              fields: ['recipient^3', 'subject^2', 'body'],
              fuzziness: 'AUTO',
            },
          },
        ],
        minimum_should_match: 1,
      },
    },
    highlight: {
      // Control characters, not HTML, mark matches: the UI splits on them and
      // renders plain text nodes, so user content can never inject markup.
      pre_tags: ['\u0002'],
      post_tags: ['\u0003'],
      fields: { body: { fragment_size: 120, number_of_fragments: 1, no_match_size: 120 } },
    },
  });
  const total =
    typeof response.hits.total === 'number'
      ? response.hits.total
      : (response.hits.total?.value ?? 0);
  return {
    total,
    items: response.hits.hits.flatMap((hit) => {
      const doc = hit._source;
      if (!doc || !hit._id) return [];
      return [
        {
          id: hit._id,
          campaignId: doc.campaignId,
          recipient: doc.recipient,
          subject: doc.subject,
          preview: hit.highlight?.body?.[0] ?? '',
          status: doc.status,
          scheduledAt: String(doc.scheduledAt),
          sentAt: doc.sentAt ? String(doc.sentAt) : null,
          score: hit._score ?? null,
        },
      ];
    }),
  };
}
