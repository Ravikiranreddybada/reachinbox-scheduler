import { env } from '../config/env.js';
import { redis } from '../lib/infra.js';
import { keys } from '../lib/keys.js';

const HOUR_MS = 3_600_000;

/**
 * Admission control for one send, decided atomically in Redis so it holds
 * across any number of worker replicas.
 *
 * The script reserves a *send slot* instead of polling:
 *
 *   slot = max(now, lastSlotForSender + MIN_SEND_INTERVAL_MS)
 *
 * Hourly quotas are a true sliding window. Each quota is a sorted set whose
 * members are email IDs and whose scores are send slots. A slot is admitted
 * only if fewer than `limit` entries lie within the hour that ends at the
 * slot (entries after the slot count too, which is the safe side). So no
 * 60-minute span ever holds more than `limit` sends, also across a clock-hour
 * boundary. When full, the retry time is the moment the oldest blocking entry
 * leaves the window.
 *
 * Quotas: sender, campaign, tenant, and global (all tenants).
 *
 * The member is the email ID, so a retried job re-reserves without charging
 * twice, and a cancelled or failed email gives its quota back (releaseQuota).
 *
 * Reservations are bounded by a look-ahead horizon. A slot beyond the horizon
 * is not reserved; the job is deferred to the horizon edge.
 *
 * KEYS: 1 sender pace, 2 sender quota, 3 campaign quota, 4 tenant quota,
 *       5 global quota
 * ARGV: 1 now, 2 interval, 3 horizon, 4 hour ms, 5 sender limit,
 *       6 campaign limit, 7 tenant limit, 8 global limit, 9 member
 */
const reserveScript = `
local now = tonumber(ARGV[1])
local interval = tonumber(ARGV[2])
local horizon = tonumber(ARGV[3])
local hour = tonumber(ARGV[4])
local member = ARGV[9]
local last = tonumber(redis.call('GET', KEYS[1]) or '0')
local slot = math.max(now, last + interval)
if slot > now + horizon then
  return {'defer', tostring(slot - horizon), '', 0}
end
local from = string.format('%.0f', slot - hour)
local limits = {
  {'sender', KEYS[2], tonumber(ARGV[5])},
  {'campaign', KEYS[3], tonumber(ARGV[6])},
  {'tenant', KEYS[4], tonumber(ARGV[7])},
  {'global', KEYS[5], tonumber(ARGV[8])},
}
for _, item in ipairs(limits) do
  redis.call('ZREMRANGEBYSCORE', item[2], '-inf', string.format('%.0f', now - hour))
  redis.call('ZREM', item[2], member)
end
for _, item in ipairs(limits) do
  local used = redis.call('ZCOUNT', item[2], '(' .. from, '+inf')
  if used >= item[3] then
    local blocker = redis.call('ZRANGEBYSCORE', item[2], '(' .. from, '+inf',
      'WITHSCORES', 'LIMIT', used - item[3], 1)
    return {'quota', string.format('%.0f', tonumber(blocker[2]) + hour), item[1], item[3]}
  end
end
for _, item in ipairs(limits) do
  redis.call('ZADD', item[2], string.format('%.0f', slot), member)
  redis.call('PEXPIRE', item[2], hour * 2 + horizon)
end
redis.call('SET', KEYS[1], tostring(slot), 'PX', math.max(1, slot - now) + interval + 60000)
return {'reserved', tostring(slot), '', 0}
`;

export type QuotaScope = 'sender' | 'campaign' | 'tenant' | 'global';

export type GateDecision =
  | { kind: 'reserved'; slotAt: number }
  | { kind: 'defer'; retryAt: number }
  | { kind: 'quota'; retryAt: number; scope: QuotaScope; limit: number; window: number };

export interface GateRequest {
  userId: string;
  senderId: string;
  campaignId: string;
  /** Used as the sorted-set member, so one email is never charged twice. */
  emailId: string;
  campaignHourlyLimit?: number | null;
  now?: number;
}

export const RESERVATION_HORIZON_MS = 15 * 60_000;

export interface QuotaOwner {
  userId: string;
  senderId: string;
  campaignId: string;
}

const quotaKeys = (owner: QuotaOwner) => [
  keys.senderQuota(owner.userId, owner.senderId),
  keys.campaignQuota(owner.userId, owner.campaignId),
  keys.tenantQuota(owner.userId),
  keys.globalQuota,
];

export async function reserveSendSlot(request: GateRequest): Promise<GateDecision> {
  const now = request.now ?? Date.now();
  const senderLimit = env.MAX_EMAILS_PER_HOUR_PER_SENDER;
  const campaignLimit = request.campaignHourlyLimit ?? senderLimit;
  const [kind, at, extra, limit] = (await redis.eval(
    reserveScript,
    5,
    keys.senderPace(request.userId, request.senderId),
    ...quotaKeys(request),
    now,
    env.MIN_SEND_INTERVAL_MS,
    RESERVATION_HORIZON_MS,
    HOUR_MS,
    senderLimit,
    campaignLimit,
    env.MAX_EMAILS_PER_HOUR_PER_TENANT,
    env.MAX_EMAILS_PER_HOUR_GLOBAL,
    request.emailId,
  )) as [string, string, string, number];

  if (kind === 'reserved') return { kind, slotAt: Number(at) };
  if (kind === 'defer') return { kind, retryAt: Number(at) };
  return {
    kind: 'quota',
    retryAt: Number(at),
    scope: extra as QuotaScope,
    limit: Number(limit),
    // Clock hour of the alert, only used to send one Slack message per hour.
    window: Math.floor(now / HOUR_MS),
  };
}

/**
 * Gives quota back for emails that will never be sent (cancelled, or failed
 * with a known SMTP rejection). Safe to call for an email with no reservation.
 */
export async function releaseQuota(items: Array<QuotaOwner & { emailId: string }>): Promise<void> {
  if (!items.length) return;
  const pipeline = redis.pipeline();
  for (const item of items) {
    for (const key of quotaKeys(item)) pipeline.zrem(key, item.emailId);
  }
  await pipeline.exec();
}

/**
 * Execution-time guard. A reservation spaces *permissions*; BullMQ timer
 * jitter can still run a late job right next to an on-time one. This check
 * makes the real send starts of one sender at least `interval` apart.
 * It almost always passes at once, so it costs one Redis call per email.
 */
const startScript = `
local now = tonumber(ARGV[1])
local interval = tonumber(ARGV[2])
local last = tonumber(redis.call('GET', KEYS[1]) or '-1')
if last >= 0 and now - last < interval then return interval - (now - last) end
redis.call('SET', KEYS[1], tostring(now), 'PX', interval + 60000)
return 0
`;

/** Returns 0 when the send may start now, else the milliseconds to wait. */
export async function acquireSendStart(userId: string, senderId: string, now = Date.now()) {
  if (env.MIN_SEND_INTERVAL_MS === 0) return 0;
  return Number(
    await redis.eval(
      startScript,
      1,
      keys.senderLastStart(userId, senderId),
      now,
      env.MIN_SEND_INTERVAL_MS,
    ),
  );
}

/**
 * Spread jobs that hit a full hour across the first minutes of the next hour
 * so thousands of deferred jobs do not wake in the same millisecond.
 */
export function withJitter(at: number, maxJitterMs = 60_000): number {
  return at + Math.floor(Math.random() * maxJitterMs);
}
