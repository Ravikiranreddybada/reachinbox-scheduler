import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {
    SESSION_SECRET: 'unit-test-secret-with-at-least-32-characters',
    API_PUBLIC_URL: 'http://localhost:4000',
  },
}));

import { unsubscribeToken, unsubscribeUrl, verifyUnsubscribeToken } from './unsubscribe.js';

describe('unsubscribe tokens', () => {
  it('round-trips the email ID', () => {
    expect(verifyUnsubscribeToken(unsubscribeToken('ckabc123'))).toBe('ckabc123');
  });

  it('rejects a token for a different email ID', () => {
    const [, signature] = unsubscribeToken('ckabc123').split('.');
    expect(verifyUnsubscribeToken(`ckother999.${signature}`)).toBeNull();
  });

  it('rejects garbage and truncated tokens', () => {
    expect(verifyUnsubscribeToken('nonsense')).toBeNull();
    expect(verifyUnsubscribeToken('ckabc123.')).toBeNull();
    expect(verifyUnsubscribeToken('.sig')).toBeNull();
  });

  it('builds an absolute link', () => {
    expect(unsubscribeUrl('ckabc123')).toMatch(/^http:\/\/localhost:4000\/unsubscribe\/ckabc123\./);
  });
});
