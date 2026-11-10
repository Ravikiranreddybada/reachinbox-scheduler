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

/**
 * Fan-out over Redis pub/sub so any API replica can push an update to the
 * browser that is connected to it. Delivery is best-effort by design: the
 * dashboard treats an event as "refresh now" and PostgreSQL stays the truth.
 */
export function publishEvent(userId: string, event: DashboardEvent): void {
  redis
    .publish(keys.userEvents(userId), JSON.stringify(event))
    .catch((error) => logger.warn({ event: 'events.publish_failed', err: error }));
}
