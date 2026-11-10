import type { Request, Response } from 'express';
import Redis from 'ioredis';
import { env } from '../config/env.js';
import { redis } from '../lib/infra.js';
import { keys } from '../lib/keys.js';
import { logger } from '../lib/logger.js';

/**
 * Server-Sent Events hub. One Redis subscriber per API process (not one per
 * browser) receives every tenant channel and routes messages to the local
 * connections of that tenant only.
 */
const clients = new Map<string, Set<Response>>();
let subscriber: Redis | null = null;

function ensureSubscriber(): void {
  if (subscriber) return;
  subscriber = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  void subscriber.psubscribe(keys.userEventsPattern);
  subscriber.on('pmessage', (_pattern, channel, message) => {
    const userId = channel.slice(keys.userEventsPattern.length - 1);
    // Message format: "<stream id> <json>". The stream ID becomes the SSE id.
    const split = message.indexOf(' ');
    if (split < 1) return;
    const frame = `id: ${message.slice(0, split)}\ndata: ${message.slice(split + 1)}\n\n`;
    for (const res of clients.get(userId) ?? []) res.write(frame);
  });
  subscriber.on('error', (error) => logger.warn({ event: 'events.subscriber_error', err: error }));
}

const STREAM_ID = /^\d+-\d+$/;

/** Stream IDs are "<ms>-<seq>": compare them as numbers, not as strings. */
export function streamIdBefore(a: string, b: string): boolean {
  const [aMs, aSeq] = a.split('-').map(BigInt) as [bigint, bigint];
  const [bMs, bSeq] = b.split('-').map(BigInt) as [bigint, bigint];
  return aMs < bMs || (aMs === bMs && aSeq < bSeq);
}

/** Writes the events a reconnecting browser missed, oldest first. */
async function replayMissed(userId: string, lastId: string, res: Response): Promise<void> {
  const log = keys.userEventLog(userId);
  const [oldest] = await redis.xrange(log, '-', '+', 'COUNT', 1);
  // The log is capped and expires. If the client's last ID is older than the
  // oldest kept entry, some events are gone: tell it to refetch everything.
  if (!oldest || streamIdBefore(lastId, oldest[0])) {
    res.write(`data: ${JSON.stringify({ type: 'resync' })}\n\n`);
  }
  const missed = await redis.xrange(log, `(${lastId}`, '+', 'COUNT', 500);
  for (const [id, fields] of missed) {
    res.write(`id: ${id}\ndata: ${fields[1]}\n\n`);
  }
}

export function streamEvents(req: Request, res: Response): void {
  ensureSubscriber();
  const userId = req.userId!;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 5000\n\n');
  const set = clients.get(userId) ?? new Set<Response>();
  set.add(res);
  clients.set(userId, set);
  const lastId = req.get('last-event-id');
  if (lastId && STREAM_ID.test(lastId)) {
    replayMissed(userId, lastId, res).catch((error) =>
      logger.warn({ event: 'events.replay_failed', err: error }),
    );
  }
  // Comment frames keep proxies and load balancers from closing an idle stream.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    set.delete(res);
    if (!set.size) clients.delete(userId);
  });
}

export function connectedStreamCount(): number {
  let total = 0;
  for (const set of clients.values()) total += set.size;
  return total;
}

export async function closeEventStreams(): Promise<void> {
  for (const set of clients.values()) for (const res of set) res.end();
  clients.clear();
  await subscriber?.quit().catch(() => undefined);
  subscriber = null;
}
