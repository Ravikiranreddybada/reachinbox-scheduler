import type { Request, Response } from 'express';
import Redis from 'ioredis';
import { env } from '../config/env.js';
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
    for (const res of clients.get(userId) ?? []) res.write(`data: ${message}\n\n`);
  });
  subscriber.on('error', (error) => logger.warn({ event: 'events.subscriber_error', err: error }));
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
