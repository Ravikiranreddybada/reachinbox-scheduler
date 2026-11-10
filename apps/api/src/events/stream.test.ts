import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({ env: { REDIS_URL: 'redis://localhost:6379' } }));
vi.mock('../lib/infra.js', () => ({ redis: {} }));
vi.mock('../lib/logger.js', () => ({ logger: { warn: vi.fn() } }));

import { streamIdBefore } from './stream.js';

describe('streamIdBefore', () => {
  it('orders by milliseconds numerically, not as text', () => {
    expect(streamIdBefore('9-0', '10-0')).toBe(true);
    expect(streamIdBefore('10-0', '9-0')).toBe(false);
  });

  it('breaks ties on the sequence number', () => {
    expect(streamIdBefore('5-1', '5-2')).toBe(true);
    expect(streamIdBefore('5-2', '5-2')).toBe(false);
  });
});
