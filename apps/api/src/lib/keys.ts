/**
 * Redis key builders.
 *
 * Every per-tenant key carries the `{tenant}` hash tag, so all keys touched by
 * one Lua script map to the same Redis Cluster slot. Without the tag a
 * multi-key script fails with CROSSSLOT as soon as Redis is sharded.
 */
const tag = (userId: string) => `{${userId}}`;

export const keys = {
  // Quota keys are sorted sets (member = email ID, score = send time in ms),
  // so the hourly limit is a true sliding window, not a fixed clock hour.
  senderQuota: (userId: string, senderId: string) => `ri:quota:${tag(userId)}:sender:${senderId}`,
  tenantQuota: (userId: string) => `ri:quota:${tag(userId)}:tenant`,
  campaignQuota: (userId: string, campaignId: string) =>
    `ri:quota:${tag(userId)}:campaign:${campaignId}`,
  // One key for all tenants. This trades Redis Cluster slot-locality for a
  // truly global cap; the local demo runs on one Redis node.
  globalQuota: 'ri:quota:global',
  // Marker that the quota sets were rebuilt from PostgreSQL. A Redis wipe
  // deletes it, which is the signal to rebuild.
  quotaHydrated: 'ri:quota:hydrated',
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
  // Capped Redis stream of recent events, replayed after an SSE reconnect.
  userEventLog: (userId: string) => `ri:eventlog:${userId}`,
} as const;
