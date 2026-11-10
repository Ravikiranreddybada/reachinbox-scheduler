import type { EmailStatus } from '@prisma/client';
import { prisma } from '../lib/infra.js';

export const TERMINAL_STATUSES: readonly EmailStatus[] = ['SENT', 'FAILED', 'CANCELLED'];

export function isTerminal(status: EmailStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export type ClaimResult =
  | { kind: 'claimed'; reclaimed: boolean }
  | { kind: 'terminal' }
  | { kind: 'held'; leaseExpiresAt: number };

/**
 * Compare-and-set transition to PROCESSING. The `WHERE` clause is the lock:
 * PostgreSQL row locking guarantees that only one concurrent UPDATE matches,
 * so two workers can never both own the same email. A PROCESSING row whose
 * lease expired is reclaimable, which heals a worker that died mid-send.
 */
export async function claimEmail(
  emailId: string,
  now: Date,
  leaseMs: number,
): Promise<ClaimResult> {
  const cutoff = new Date(now.getTime() - leaseMs);
  const claimed = await prisma.email.updateMany({
    where: {
      id: emailId,
      OR: [{ status: 'SCHEDULED' }, { status: 'PROCESSING', processingStartedAt: { lt: cutoff } }],
    },
    data: {
      status: 'PROCESSING',
      processingStartedAt: now,
      attempts: { increment: 1 },
      errorMessage: null,
    },
  });
  if (claimed.count === 1) return { kind: 'claimed', reclaimed: false };

  const current = await prisma.email.findUnique({
    where: { id: emailId },
    select: { status: true, processingStartedAt: true },
  });
  if (!current || isTerminal(current.status)) return { kind: 'terminal' };
  if (current.status === 'PROCESSING' && current.processingStartedAt) {
    return { kind: 'held', leaseExpiresAt: current.processingStartedAt.getTime() + leaseMs };
  }
  // The row changed between the two statements (for example a lease was just
  // released); treat it as held briefly so the job re-runs the claim.
  return { kind: 'held', leaseExpiresAt: now.getTime() };
}
