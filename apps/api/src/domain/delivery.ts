import type { EmailStatus } from '@prisma/client';
import { prisma } from '../lib/infra.js';

export const TERMINAL_STATUSES: readonly EmailStatus[] = ['SENT', 'FAILED', 'CANCELLED'];

export function isTerminal(status: EmailStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export type ClaimResult =
  | { kind: 'claimed'; reclaimed: boolean }
  | { kind: 'terminal' }
  | { kind: 'abandoned' }
  | { kind: 'held'; leaseExpiresAt: number };

/**
 * Compare-and-set transition to PROCESSING. The `WHERE` clause is the lock:
 * PostgreSQL row locking guarantees that only one concurrent UPDATE matches,
 * so two workers can never both own the same email.
 *
 * At-most-once after a crash. `processingStartedAt` is set by a claim and is
 * cleared only when an attempt ends with a known SMTP error. A row that still
 * has it but is claimable again means a worker died after claiming, maybe
 * after SMTP accepted the message. SMTP has no idempotency key, so the outcome
 * is unknown: the row becomes FAILED ('abandoned') instead of risking a
 * duplicate. A visible failed email is better than a silent second send.
 */
export async function claimEmail(
  emailId: string,
  now: Date,
  leaseMs: number,
): Promise<ClaimResult> {
  const cutoff = new Date(now.getTime() - leaseMs);
  const claimed = await prisma.email.updateMany({
    where: { id: emailId, status: 'SCHEDULED', processingStartedAt: null },
    data: {
      status: 'PROCESSING',
      processingStartedAt: now,
      attempts: { increment: 1 },
      errorMessage: null,
    },
  });
  if (claimed.count === 1) return { kind: 'claimed', reclaimed: false };

  const abandoned = await prisma.email.updateMany({
    where: {
      id: emailId,
      OR: [
        { status: 'SCHEDULED', processingStartedAt: { not: null } },
        { status: 'PROCESSING', processingStartedAt: { lt: cutoff } },
      ],
    },
    data: { status: 'FAILED', errorMessage: ABANDONED_MESSAGE },
  });
  if (abandoned.count === 1) return { kind: 'abandoned' };

  const current = await prisma.email.findUnique({
    where: { id: emailId },
    select: { status: true, processingStartedAt: true },
  });
  if (!current || isTerminal(current.status)) return { kind: 'terminal' };
  if (current.status === 'PROCESSING' && current.processingStartedAt) {
    return { kind: 'held', leaseExpiresAt: current.processingStartedAt.getTime() + leaseMs };
  }
  // The row changed between the statements; re-run the claim shortly.
  return { kind: 'held', leaseExpiresAt: now.getTime() };
}

export const ABANDONED_MESSAGE =
  'Delivery outcome unknown after a worker crash. Not resent, to avoid a duplicate email.';
