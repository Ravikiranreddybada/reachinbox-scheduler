import { createHash } from 'node:crypto';
import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env.js';
import { decryptSecret } from '../lib/crypto.js';

export interface SenderCredentials {
  id: string;
  smtpUser: string | null;
  smtpPassword: string | null;
}

const MAX_SENDER_TRANSPORTS = 50;

function smtpOptions(auth?: { user: string; pass: string }, maxConnections = 10) {
  return {
    host: env.ETHEREAL_HOST,
    port: env.ETHEREAL_PORT,
    secure: env.ETHEREAL_PORT === 465,
    auth,
    pool: true,
    maxConnections: Math.min(maxConnections, 10),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  };
}

/** Shared account from the environment: used by senders that have no login of their own. */
const defaultTransport: Transporter =
  env.DELIVERY_TRANSPORT === 'stream'
    ? nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' })
    : nodemailer.createTransport(
        smtpOptions(
          env.ETHEREAL_USER && env.ETHEREAL_PASSWORD
            ? { user: env.ETHEREAL_USER, pass: env.ETHEREAL_PASSWORD }
            : undefined,
          env.WORKER_CONCURRENCY,
        ),
      );

/** Insertion-ordered, so the first key is the oldest entry. */
const senderTransports = new Map<string, Transporter>();

/**
 * Returns the SMTP transport for a sender. A sender with its own login sends
 * through its own authenticated connection pool; the rest share the default
 * account. Pools are cached by credentials, so a changed password is picked up
 * on the next send, and at most 50 pools stay open.
 */
export function transportFor(sender: SenderCredentials): Transporter {
  if (env.DELIVERY_TRANSPORT === 'stream' || !sender.smtpUser || !sender.smtpPassword) {
    return defaultTransport;
  }
  const cacheKey = `${sender.id}:${sender.smtpUser}:${createHash('sha256').update(sender.smtpPassword).digest('hex').slice(0, 16)}`;
  const cached = senderTransports.get(cacheKey);
  if (cached) return cached;
  const transport = nodemailer.createTransport(
    smtpOptions({ user: sender.smtpUser, pass: decryptSecret(sender.smtpPassword) }, 2),
  );
  senderTransports.set(cacheKey, transport);
  if (senderTransports.size > MAX_SENDER_TRANSPORTS) {
    const oldest = senderTransports.keys().next().value;
    if (oldest) {
      senderTransports.get(oldest)?.close();
      senderTransports.delete(oldest);
    }
  }
  return transport;
}

export async function verifyDefaultTransport(): Promise<void> {
  if (env.DELIVERY_TRANSPORT === 'stream') return;
  if (!env.ETHEREAL_USER || !env.ETHEREAL_PASSWORD) {
    throw new Error(
      'Ethereal SMTP credentials are missing. Configure ETHEREAL_USER and ETHEREAL_PASSWORD.',
    );
  }
  await defaultTransport.verify();
}

/** Checks a login against the SMTP server without caching it. */
export async function verifySmtpLogin(user: string, pass: string): Promise<void> {
  if (env.DELIVERY_TRANSPORT === 'stream') return;
  const probe = nodemailer.createTransport({ ...smtpOptions({ user, pass }, 1), pool: false });
  try {
    await probe.verify();
  } finally {
    probe.close();
  }
}

export function closeTransports(): void {
  defaultTransport.close();
  for (const transport of senderTransports.values()) transport.close();
  senderTransports.clear();
}
