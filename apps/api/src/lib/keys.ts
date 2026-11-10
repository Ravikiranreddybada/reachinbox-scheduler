/**
 * Redis key builders.
 *
 * Every per-tenant key carries the `{tenant}` hash tag, so all keys touched by
 * one Lua script map to the same Redis Cluster slot. Without the tag a
 * multi-key script fails with CROSSSLOT as soon as Redis is sharded.
 */
const tag = (userId: string) => `{${userId}}`;

export const keys = {
  senderQuota: (userId: string, senderId: string, window: number) =>
    `ri:quota:${tag(userId)}:sender:${senderId}:${window}`,
  tenantQuota: (userId: string, window: number) => `ri:quota:${tag(userId)}:tenant:${window}`,
  campaignQuota: (userId: string, campaignId: string, window: number) =>
    `ri:quota:${tag(userId)}:campaign:${campaignId}:${window}`,
  senderPace: (userId: string, senderId: string) => `ri:pace:${tag(userId)}:sender:${senderId}`,
  senderLastStart: (userId: string, senderId: string) =>
    `ri:pace:${tag(userId)}:sender:${senderId}:started`,
  deliveryReceipt: (emailId: string) => `ri:receipt:${emailId}`,
  quotaAlert: (userId: string, scope: string, subject: string, window: number) =>
    `ri:alert:${tag(userId)}:${scope}:${subject}:${window}`,
  revokedSession: (jti: string) => `ri:session:revoked:${jti}`,
  httpRate: (bucket: string, subject: string, window: number) =>
    `ri:http:${bucket}:${subject}:${window}`,
  leaderLock: (name: string) => `ri:lock:${name}`,
  userEvents: (userId: string) => `ri:events:${userId}`,
  userEventsPattern: 'ri:events:*',
} as const;
