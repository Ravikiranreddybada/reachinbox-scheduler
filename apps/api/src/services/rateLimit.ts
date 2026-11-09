import { env } from '../config/env.js';
import { utcHourWindow } from '../domain/rateWindow.js';
import { redis } from '../lib/infra.js';
import { notifyRateLimit } from './notifications.js';

const consumeScript = `
local senderCount = tonumber(redis.call('GET', KEYS[1]) or '0')
local globalCount = tonumber(redis.call('GET', KEYS[2]) or '0')
if senderCount >= tonumber(ARGV[2]) then return {'sender', senderCount, globalCount} end
if globalCount >= tonumber(ARGV[3]) then return {'global', senderCount, globalCount} end
senderCount = redis.call('INCR', KEYS[1])
globalCount = redis.call('INCR', KEYS[2])
if senderCount == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
if globalCount == 1 then redis.call('EXPIRE', KEYS[2], ARGV[1]) end
return {'allowed', senderCount, globalCount}
`;

export async function acquireSenderSlot(
  userId: string,
  senderId: string,
  senderEmail: string,
  configuredLimit?: number | null,
): Promise<{ allowed: boolean; nextAt: number; scope?: 'sender' | 'global' }> {
  const now = Date.now();
  const { window, nextAt } = utcHourWindow(now);
  const senderLimit = configuredLimit ?? env.MAX_EMAILS_PER_HOUR_PER_SENDER;
  const globalLimit = env.MAX_EMAILS_PER_HOUR_GLOBAL;
  const senderKey = `rate:sender:${userId}:${senderId}:${window}`;
  const globalKey = `rate:global:${userId}:${window}`;
  const result = (await redis.eval(
    consumeScript,
    2,
    senderKey,
    globalKey,
    3700,
    senderLimit,
    globalLimit,
  )) as [string, number, number];
  const scope = result[0];
  if (scope === 'allowed') return { allowed: true, nextAt: now };

  const limit = scope === 'global' ? globalLimit : senderLimit;
  await notifyRateLimit(
    userId,
    senderEmail,
    String(window),
    limit,
    scope as 'sender' | 'global',
  ).catch((error) => console.error('Slack rate-limit notification failed', error));
  return { allowed: false, nextAt, scope: scope as 'sender' | 'global' };
}
