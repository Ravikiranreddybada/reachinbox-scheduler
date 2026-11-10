import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { SESSION_SECRET: 'unit-test-secret-with-at-least-32-characters' },
}));

import { decryptSecret, encryptSecret } from './crypto.js';

describe('secret encryption at rest', () => {
  it('round-trips and never stores the plaintext', () => {
    const url = 'https://hooks.slack.com/services/T000/B000/XXXX';
    const stored = encryptSecret(url);
    expect(stored.startsWith('enc:v1:')).toBe(true);
    expect(stored).not.toContain('hooks.slack.com');
    expect(decryptSecret(stored)).toBe(url);
  });

  it('uses a fresh IV per value', () => {
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });

  it('detects tampering through the GCM tag', () => {
    const stored = encryptSecret('secret');
    const tampered = `${stored.slice(0, -2)}${stored.endsWith('A') ? 'B' : 'A'}A`;
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('reads legacy plaintext rows written before encryption', () => {
    expect(decryptSecret('https://hooks.slack.com/legacy')).toBe('https://hooks.slack.com/legacy');
  });
});
