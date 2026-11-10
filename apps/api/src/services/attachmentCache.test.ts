import { beforeEach, describe, expect, it, vi } from 'vitest';

const findMany = vi.hoisted(() => vi.fn());
vi.mock('../config/env.js', () => ({ env: { ATTACHMENT_CACHE_BYTES: 100 } }));
vi.mock('../lib/infra.js', () => ({ prisma: { attachment: { findMany } } }));

import {
  attachmentCacheStats,
  attachmentsForCampaign,
  clearAttachmentCache,
} from './attachmentCache.js';

const file = (bytes: number) => [
  { filename: 'f.bin', contentType: 'application/octet-stream', data: new Uint8Array(bytes) },
];

describe('attachment cache', () => {
  beforeEach(() => {
    clearAttachmentCache();
    findMany.mockReset();
  });

  it('reads the database once for many sends of one campaign', async () => {
    findMany.mockResolvedValue(file(40));
    for (let i = 0; i < 50; i += 1) await attachmentsForCampaign('c1');
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('evicts the least recently used campaign when the byte budget is full', async () => {
    findMany.mockResolvedValue(file(60));
    await attachmentsForCampaign('c1');
    await attachmentsForCampaign('c2'); // 120 > 100: c1 is evicted
    expect(attachmentCacheStats()).toEqual({ entries: 1, bytes: 60 });
    await attachmentsForCampaign('c1');
    expect(findMany).toHaveBeenCalledTimes(3);
  });

  it('does not cache a campaign larger than the whole budget', async () => {
    findMany.mockResolvedValue(file(500));
    await attachmentsForCampaign('big');
    await attachmentsForCampaign('big');
    expect(attachmentCacheStats().entries).toBe(0);
    expect(findMany).toHaveBeenCalledTimes(2);
  });
});
