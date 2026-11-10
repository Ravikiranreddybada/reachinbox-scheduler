import { env } from '../config/env.js';
import { utcHourWindow } from '../domain/rateWindow.js';
import { redis } from '../lib/infra.js';
import { keys } from '../lib/keys.js';

/**
 * Admission control for one send, decided atomically in Redis so it holds
 * across any number of worker replicas.
 *
 * The script reserves a *send slot* instead of polling:
 *
 *   slot = max(now, lastSlotForSender + MIN_SEND_INTERVAL_MS)
 *
 * The hourly quotas (sender, campaign, tenant) are charged to the UTC hour in
 * which `slot` falls, which is the hour in which the send really happens.
 * A job that receives a future slot sleeps in BullMQ until that instant and
 * then sends without asking again, so each email costs O(1) Redis calls no
 * matter how many emails compete for one sender. Polling designs cost
 * O(n^2) wake-ups when thousands of emails are due at the same time.
 *
 * Reservations are bounded by a look-ahead horizon. A slot beyond the horizon
 * is not reserved; the job is deferred to the horizon edge. This caps the
 * pacing time that a cancelled campaign can waste for the next campaign.
 *
 * KEYS: 1 sender pace,
 *       2-4 sender/campaign/tenant quota for the current hour,
 *       5-7 the same quotas for the next hour.
 * Every key is declared up front (Redis Cluster rule); the horizon is shorter
 * than one hour, so a slot always falls in the current or the next hour.
 * ARGV: 1 now, 2 interval, 3 horizon, 4 hour ms, 5 current window,
 *       6 sender limit, 7 campaign limit, 8 tenant limit
 */
const reserveScript = `
local now = tonumber(ARGV[1])
local interval = tonumber(ARGV[2])
local horizon = tonumber(ARGV[3])
local hour = tonumber(ARGV[4])
local current = tonumber(ARGV[5])
local last = tonumber(redis.call('GET', KEYS[1]) or '0')
local slot = math.max(now, last + interval)
if slot > now + horizon then
  return {'defer', tostring(slot - horizon), '', 0}
end
local window = math.floor(slot / hour)
local offset = 1
if window > current then offset = 4 end
local limits = {
  {'sender', KEYS[offset + 1], tonumber(ARGV[6])},
  {'campaign', KEYS[offset + 2], tonumber(ARGV[7])},
  {'tenant', KEYS[offset + 3], tonumber(ARGV[8])},
}
for _, item in ipairs(limits) do
  local used = tonumber(redis.call('GET', item[2]) or '0')
  if used >= item[3] then
    return {'quota', tostring((window + 1) * hour), item[1], item[3]}
  end
end
local ttl = math.floor(hour / 1000) * 2 + 300
for _, item in ipairs(limits) do
  if redis.call('INCR', item[2]) == 1 then redis.call('EXPIRE', item[2], ttl) end
end
redis.call('SET', KEYS[1], tostring(slot), 'PX', math.max(1, slot - now) + interval + 60000)
return {'reserved', tostring(slot), tostring(window), 0}
`;

export type QuotaScope = 'sender' | 'campaign' | 'tenant';

export type GateDecision =
  | { kind: 'reserved'; slotAt: number; window: number }
  | { kind: 'defer'; retryAt: number }
  | { kind: 'quota'; retryAt: number; scope: QuotaScope; limit: number; window: number };

export interface GateRequest {
  userId: string;
  senderId: string;
  campaignId: string;
  campaignHourlyLimit?: number | null;
  now?: number;
}

export const RESERVATION_HORIZON_MS = 15 * 60_000;

export async function reserveSendSlot(request: GateRequest): Promise<GateDecision> {
  const now = request.now ?? Date.now();
  const senderLimit = env.MAX_EMAILS_PER_HOUR_PER_SENDER;
  const campaignLimit = request.campaignHourlyLimit ?? senderLimit;
  const { window } = utcHourWindow(now);
  const quotaKeys = (w: number) => [
    keys.senderQuota(request.userId, request.senderId, w),
    keys.campaignQuota(request.userId, request.campaignId, w),
    keys.tenantQuota(request.userId, w),
  ];
  const [kind, at, extra, limit] = (await redis.eval(
    reserveScript,
    7,
    keys.senderPace(request.userId, request.senderId),
    ...quotaKeys(window),
    ...quotaKeys(window + 1),
    now,
    env.MIN_SEND_INTERVAL_MS,
    RESERVATION_HORIZON_MS,
    3_600_000,
    window,
    senderLimit,
    campaignLimit,
    env.MAX_EMAILS_PER_HOUR_GLOBAL,
  )) as [string, string, string, number];

  if (kind === 'reserved') return { kind, slotAt: Number(at), window: Number(extra) };
  if (kind === 'defer') return { kind, retryAt: Number(at) };
  return {
    kind: 'quota',
    retryAt: Number(at),
    scope: extra as QuotaScope,
    limit: Number(limit),
    window: utcHourWindow(Number(at) - 1).window,
  };
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
