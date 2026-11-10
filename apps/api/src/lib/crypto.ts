import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * AES-256-GCM encryption for third-party secrets at rest (Slack webhook URLs
 * and tokens). A Slack incoming-webhook URL is a bearer credential: anyone
 * who reads it can post into the customer's channel, so a database dump must
 * not leak it.
 *
 * Format: `enc:v1:<iv>.<tag>.<ciphertext>` (base64url). The version prefix
 * allows key rotation; values without the prefix are legacy plaintext and are
 * still readable so existing rows keep working. DATA_ENCRYPTION_KEY is
 * required (no derived fallback); retired keys go in DATA_ENCRYPTION_KEY_PREVIOUS.
 */
const PREFIX = 'enc:v1:';

const toKey = (base64: string) => Buffer.from(base64, 'base64');
/** The first key encrypts. Retired keys only decrypt, so a rotation never locks data out. */
const key: Buffer = toKey(env.DATA_ENCRYPTION_KEY);
const retiredKeys: Buffer[] = env.DATA_ENCRYPTION_KEY_PREVIOUS.map(toKey);

for (const candidate of [key, ...retiredKeys]) {
  if (candidate.length !== 32) throw new Error('Encryption keys must be 32 bytes, base64 encoded.');
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${PREFIX}${[iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.')}`;
}

function decryptWith(candidate: Buffer, iv: Buffer, tag: Buffer, data: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', candidate, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function decryptSecret(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored;
  const [iv, tag, data] = stored
    .slice(PREFIX.length)
    .split('.')
    .map((part) => Buffer.from(part, 'base64url'));
  if (!iv || !tag || !data) throw new Error('Encrypted secret is malformed.');
  let lastError: unknown;
  for (const candidate of [key, ...retiredKeys]) {
    try {
      return decryptWith(candidate, iv, tag, data);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Secret could not be decrypted.');
}

/** True when the value is ciphertext made with the current key (no rotation needed). */
export function isCurrentCiphertext(stored: string): boolean {
  if (!stored.startsWith(PREFIX)) return false;
  const [iv, tag, data] = stored
    .slice(PREFIX.length)
    .split('.')
    .map((part) => Buffer.from(part, 'base64url'));
  if (!iv || !tag || !data) return false;
  try {
    decryptWith(key, iv, tag, data);
    return true;
  } catch {
    return false;
  }
}
