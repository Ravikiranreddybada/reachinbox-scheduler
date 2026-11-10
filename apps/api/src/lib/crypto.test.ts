import { beforeAll, describe, expect, it, vi } from 'vitest';

const OLD_KEY = Buffer.alloc(32, 7).toString('base64');
const NEW_KEY = Buffer.alloc(32, 9).toString('base64');
const state = vi.hoisted(() => ({ current: '', previous: [] as string[] }));

vi.mock('../config/env.js', () => ({
  env: {
    get DATA_ENCRYPTION_KEY() {
      return state.current;
    },
    get DATA_ENCRYPTION_KEY_PREVIOUS() {
      return state.previous;
    },
  },
}));

async function loadWith(current: string, previous: string[] = []) {
  state.current = current;
  state.previous = previous;
  vi.resetModules();
  return import('./crypto.js');
}

let encryptSecret: typeof import('./crypto.js').encryptSecret;
let decryptSecret: typeof import('./crypto.js').decryptSecret;

beforeAll(async () => {
  ({ decryptSecret, encryptSecret } = await loadWith(OLD_KEY));
});

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

  it('rotates: a retired key still decrypts, and new writes use the new key', async () => {
    const stored = encryptSecret('smtp-password');
    const rotated = await loadWith(NEW_KEY, [OLD_KEY]);
    expect(rotated.decryptSecret(stored)).toBe('smtp-password');
    expect(rotated.isCurrentCiphertext(stored)).toBe(false);
    const reencrypted = rotated.encryptSecret(rotated.decryptSecret(stored));
    expect(rotated.isCurrentCiphertext(reencrypted)).toBe(true);
    // Without the retired key the old value is unreadable: no silent fallback.
    const noFallback = await loadWith(NEW_KEY);
    expect(() => noFallback.decryptSecret(stored)).toThrow();
  });
});
