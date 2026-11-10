import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * AES-256-GCM encryption for third-party secrets at rest (Slack webhook URLs
 * and tokens). A Slack incoming-webhook URL is a bearer credential: anyone
 * who reads it can post into the customer's channel, so a database dump must
 * not leak it.
 *
 * Format: `enc:v1:<iv>.<tag>.<ciphertext>` (base64url). The version prefix
 * allows key rotation; values without the prefix are legacy plaintext and are
 * still readable so existing rows keep working.
 */
const PREFIX = 'enc:v1:';

const key: Buffer = env.DATA_ENCRYPTION_KEY
  ? Buffer.from(env.DATA_ENCRYPTION_KEY, 'base64')
  : Buffer.from(hkdfSync('sha256', env.SESSION_SECRET, 'reachinbox', 'data-encryption-v1', 32));

if (key.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes, base64 encoded.');

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${PREFIX}${[iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.')}`;
}

export function decryptSecret(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored;
  const [iv, tag, data] = stored
    .slice(PREFIX.length)
    .split('.')
    .map((part) => Buffer.from(part, 'base64url'));
  if (!iv || !tag || !data) throw new Error('Encrypted secret is malformed.');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
