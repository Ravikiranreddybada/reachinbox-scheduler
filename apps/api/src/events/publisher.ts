import { redis } from '../lib/infra.js';
import { keys } from '../lib/keys.js';
import { logger } from '../lib/logger.js';

export type EmailStatusEvent = {
  type: 'email.status';
  emailId: string;
  campaignId: string;
  status: 'SCHEDULED' | 'PROCESSING' | 'SENT' | 'FAILED' | 'CANCELLED';
  at: string;
};
export type CampaignEvent = {
  type: 'campaign.accepted' | 'campaign.cancelled';
  campaignId: string;
  count: number;
};
export type DashboardEvent = EmailStatusEvent | CampaignEvent;

/** Events kept per user for replay after a dropped connection. */
export const EVENT_LOG_MAX = 500;
const EVENT_LOG_TTL_SECONDS = 3600;

/**
 * Fan-out over Redis pub/sub so any API replica can push an update to the
 * browser that is connected to it. Each event is also appended to a capped
 * per-user Redis stream first, and its stream ID travels with the live message
 * as the SSE `id`. After a disconnect the browser sends `Last-Event-ID` and the
 * API replays what it missed. PostgreSQL stays the truth; a refresh also works.
 */
export function publishEvent(userId: string, event: DashboardEvent): void {
  const payload = JSON.stringify(event);
  const log = keys.userEventLog(userId);
  void (async () => {
    const id = await redis.xadd(log, 'MAXLEN', '~', String(EVENT_LOG_MAX), '*', 'd', payload);
    await redis.expire(log, EVENT_LOG_TTL_SECONDS);
    await redis.publish(keys.userEvents(userId), `${id} ${payload}`);
  })().catch((error) => logger.warn({ event: 'events.publish_failed', err: error }));
}
