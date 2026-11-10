import { prisma } from '../lib/infra.js';
import { env } from '../config/env.js';

export interface LoadedAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

interface Entry {
  files: LoadedAttachment[];
  bytes: number;
  loadedAt: number;
}

const TTL_MS = 10 * 60_000;
/** Insertion-ordered; a hit re-inserts the entry, so the first key is least recently used. */
const cache = new Map<string, Entry>();
let cachedBytes = 0;

function evict(key: string): void {
  const entry = cache.get(key);
  if (!entry) return;
  cachedBytes -= entry.bytes;
  cache.delete(key);
}

/**
 * Attachment bytes for a campaign, read from PostgreSQL once per worker process
 * instead of once per recipient. Files are immutable after a campaign is
 * scheduled, so caching is safe. The cache is bounded by ATTACHMENT_CACHE_BYTES
 * (least recently used first out), and a campaign larger than the whole budget
 * is simply not cached.
 */
export async function attachmentsForCampaign(campaignId: string): Promise<LoadedAttachment[]> {
  const now = Date.now();
  const hit = cache.get(campaignId);
  if (hit && now - hit.loadedAt < TTL_MS) {
    cache.delete(campaignId);
    cache.set(campaignId, hit);
    return hit.files;
  }
  if (hit) evict(campaignId);

  const rows = await prisma.attachment.findMany({
    where: { campaignId },
    select: { filename: true, contentType: true, data: true },
  });
  const files = rows.map((row) => ({
    filename: row.filename,
    contentType: row.contentType,
    content: Buffer.from(row.data),
  }));
  const bytes = files.reduce((sum, file) => sum + file.content.length, 0);
  if (bytes <= env.ATTACHMENT_CACHE_BYTES) {
    cache.set(campaignId, { files, bytes, loadedAt: now });
    cachedBytes += bytes;
    while (cachedBytes > env.ATTACHMENT_CACHE_BYTES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      evict(oldest);
    }
  }
  return files;
}

export function attachmentCacheStats() {
  return { entries: cache.size, bytes: cachedBytes };
}

export function clearAttachmentCache(): void {
  cache.clear();
  cachedBytes = 0;
}
