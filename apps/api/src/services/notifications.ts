import { prisma, redis } from '../lib/infra.js';
export async function notifyRateLimit(
  userId: string,
  sender: string,
  windowKey: string,
  limit: number,
  scope: 'sender' | 'global' | 'campaign',
  campaignId?: string,
) {
  const connection = await prisma.slackConnection.findUnique({ where: { userId } });
  if (!connection) return;
  const onceKey = `slack:limit-notified:${scope}:${userId}:${sender}:${campaignId ?? 'all'}:${windowKey}`;
  const first = await redis.set(onceKey, '1', 'EX', 3600, 'NX');
  if (!first) return;
  try {
    const label = scope === 'global' ? 'tenant-wide' : scope === 'campaign' ? 'campaign' : 'sender';
    const response = await fetch(connection.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `Email sending for ${sender} reached the ${label} hourly limit of ${limit}. Queued messages will resume in the next UTC hour window.`,
      }),
    });
    if (!response.ok) throw new Error(`Slack notification failed with ${response.status}`);
  } catch (error) {
    await redis.del(onceKey);
    throw error;
  }
}
