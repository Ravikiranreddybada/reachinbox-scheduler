import { decryptSecret } from '../lib/crypto.js';
import { prisma, redis } from '../lib/infra.js';
import { keys } from '../lib/keys.js';
import { logger } from '../lib/logger.js';
import type { QuotaScope } from './deliveryGate.js';

export interface QuotaAlert {
  userId: string;
  senderEmail: string;
  campaignId: string;
  scope: QuotaScope;
  limit: number;
  window: number;
  resumesAt: number;
}

const scopeLabel: Record<QuotaScope, string> = {
  sender: 'sender',
  campaign: 'campaign',
  tenant: 'workspace-wide',
};

/**
 * Sends at most one Slack alert per tenant, scope, subject, and UTC hour.
 * `SET NX` is the dedupe gate across every worker replica; the key is
 * released on failure so a later job in the same hour can retry the alert.
 * Called fire-and-forget: Slack latency must never hold a delivery slot.
 */
export async function notifyQuotaReached(alert: QuotaAlert): Promise<void> {
  const subject =
    alert.scope === 'sender'
      ? alert.senderEmail
      : alert.scope === 'campaign'
        ? alert.campaignId
        : 'all';
  const onceKey = keys.quotaAlert(alert.userId, alert.scope, subject, alert.window);
  if (!(await redis.set(onceKey, '1', 'EX', 2 * 3600, 'NX'))) return;

  try {
    const connection = await prisma.slackConnection.findUnique({
      where: { userId: alert.userId },
      select: { webhookUrl: true },
    });
    if (!connection) return;
    const resumes = new Date(alert.resumesAt).toISOString().replace('.000Z', 'Z');
    const response = await fetch(decryptSecret(connection.webhookUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(5_000),
      body: JSON.stringify({
        text: `:hourglass_flowing_sand: ${alert.senderEmail} reached the ${scopeLabel[alert.scope]} hourly limit of ${alert.limit}. Queued emails are kept and resume at ${resumes}.`,
      }),
    });
    if (!response.ok) throw new Error(`Slack webhook returned ${response.status}`);
    logger.info({ event: 'slack.quota_alert_sent', userId: alert.userId, scope: alert.scope });
  } catch (error) {
    await redis.del(onceKey).catch(() => undefined);
    throw error;
  }
}
