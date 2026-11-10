import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTenant } from '../../test/fixtures.js';
import { createApp } from '../app.js';
import { issueSession } from '../lib/auth.js';
import { prisma, redis } from '../lib/infra.js';
import { emailQueue, searchSyncQueue } from '../queues/emailQueue.js';
import { reconcileDeliveryQueue } from '../services/recovery.js';

let server: Server;
let base: string;
let cookie: string;

beforeAll(async () => {
  await redis.flushdb();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { user } = await createTenant('api');
  cookie = `session=${await issueSession(user.id)}`;
});
afterAll(async () => {
  server.close();
  await Promise.all([emailQueue.close(), searchSyncQueue.close()]);
  await prisma.$disconnect();
  await redis.quit();
});

const payload = (overrides: Record<string, unknown> = {}) => ({
  sender: 'ops@example.com',
  recipients: ['a@example.com', 'B@example.com', 'b@example.com'],
  subject: 'Launch',
  body: 'Hello',
  scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
  delayBetweenMs: 2_000,
  idempotencyKey: 'idem-key-0001',
  ...overrides,
});

const post = (body: unknown, path = '/api/emails') =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

describe('POST /api/emails (real HTTP, PostgreSQL, Redis)', () => {
  it('rejects unauthenticated requests', async () => {
    const response = await fetch(`${base}/api/emails`, { method: 'POST' });
    expect(response.status).toBe(401);
  });

  it('creates one campaign for 10 concurrent identical requests', async () => {
    const body = payload();
    const responses = await Promise.all(Array.from({ length: 10 }, () => post(body)));
    const results = await Promise.all(responses.map((r) => r.json()));
    expect(responses.map((r) => r.status).filter((s) => s === 202)).toHaveLength(1);
    expect(new Set(results.map((r) => r.campaignId)).size).toBe(1);
    expect(results[0].accepted).toBe(2);
    expect(await prisma.campaign.count({ where: { idempotencyKey: 'idem-key-0001' } })).toBe(1);
    expect(await prisma.email.count({ where: { campaignId: results[0].campaignId } })).toBe(2);
  });

  it('returns 409 when a key is reused with a different payload', async () => {
    const response = await post(payload({ subject: 'Different' }));
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('rejects a cross-site write', async () => {
    const response = await fetch(`${base}/api/emails`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'https://evil.example' },
      body: JSON.stringify(payload({ idempotencyKey: 'idem-key-evil' })),
    });
    expect(response.status).toBe(403);
  });

  it('cancels a campaign and removes its jobs', async () => {
    const created = await (await post(payload({ idempotencyKey: 'idem-key-cancel' }))).json();
    const response = await post({}, `/api/campaigns/${created.campaignId}/cancel`);
    expect(await response.json()).toMatchObject({ cancelled: 2, inFlight: 0 });
    const rows = await prisma.email.findMany({ where: { campaignId: created.campaignId } });
    expect(rows.every((row) => row.status === 'CANCELLED')).toBe(true);
    for (const row of rows) expect(await emailQueue.getJob(row.id)).toBeUndefined();
  });

  it('keeps far-future emails out of Redis until they come into range', async () => {
    const week = 7 * 24 * 3_600_000;
    const created = await (
      await post(
        payload({
          idempotencyKey: 'idem-key-horizon',
          scheduledAt: new Date(Date.now() + week).toISOString(),
        }),
      )
    ).json();
    const rows = await prisma.email.findMany({ where: { campaignId: created.campaignId } });
    expect(rows).toHaveLength(2);
    // Stored in PostgreSQL, with the body once on the campaign, not on each row.
    expect(rows.every((row) => row.status === 'SCHEDULED' && row.body === null)).toBe(true);
    expect(
      (await prisma.campaign.findUniqueOrThrow({ where: { id: created.campaignId } })).body,
    ).toBe('Hello');
    for (const row of rows) expect(await emailQueue.getJob(row.id)).toBeUndefined();

    // A week later the reconciler sees them inside the horizon and queues them.
    await reconcileDeliveryQueue(new Date(Date.now() + week - 3_000_000));
    for (const row of rows) expect(await emailQueue.getJob(row.id)).toBeDefined();
  });

  it('lists with a preview and returns the full body on the detail route', async () => {
    const created = await (await post(payload({ idempotencyKey: 'idem-key-preview' }))).json();
    const list = await (
      await fetch(`${base}/api/emails?campaignId=${created.campaignId}`, { headers: { cookie } })
    ).json();
    expect(list.items[0]).toMatchObject({ preview: 'Hello' });
    expect(list.items[0]).not.toHaveProperty('campaign');
    const detail = await (
      await fetch(`${base}/api/emails/${list.items[0].id}`, { headers: { cookie } })
    ).json();
    expect(detail.body).toBe('Hello');
  });

  it('keeps tenants apart', async () => {
    const created = await (await post(payload({ idempotencyKey: 'idem-key-tenant' }))).json();
    const { user } = await createTenant('intruder');
    const response = await fetch(`${base}/api/campaigns/${created.campaignId}`, {
      headers: { cookie: `session=${await issueSession(user.id)}` },
    });
    expect(response.status).toBe(404);
  });
});

describe('POST /api/emails/:id/retry', () => {
  it('re-queues a failed email exactly once', async () => {
    const created = await (await post(payload({ idempotencyKey: 'idem-key-retry' }))).json();
    const email = await prisma.email.findFirstOrThrow({
      where: { campaignId: created.campaignId },
    });
    await prisma.email.update({
      where: { id: email.id },
      data: { status: 'FAILED', errorMessage: 'boom' },
    });

    const [first, second] = await Promise.all([
      post({}, `/api/emails/${email.id}/retry`),
      post({}, `/api/emails/${email.id}/retry`),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(await emailQueue.getJobState(email.id)).toMatch(/waiting|delayed|prioritized/);
    const row = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
    expect(row).toMatchObject({ status: 'SCHEDULED', errorMessage: null });
  });

  it('refuses to retry an email that did not fail', async () => {
    const created = await (await post(payload({ idempotencyKey: 'idem-key-retry-2' }))).json();
    const email = await prisma.email.findFirstOrThrow({
      where: { campaignId: created.campaignId },
    });
    expect((await post({}, `/api/emails/${email.id}/retry`)).status).toBe(409);
  });
});
