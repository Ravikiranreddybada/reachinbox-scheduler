import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCampaign, createTenant } from '../../test/fixtures.js';
import { createApp } from '../app.js';
import { issueSession } from '../lib/auth.js';
import { decryptSecret } from '../lib/crypto.js';
import { prisma, redis } from '../lib/infra.js';
import { unsubscribeToken } from '../lib/unsubscribe.js';
import { drainSearchOutbox, emailQueue, searchSyncQueue } from '../queues/emailQueue.js';
import { processDelivery } from '../workers/emailWorker.js';
import { transportFor } from './transports.js';

let server: Server;
let base: string;

beforeAll(async () => {
  await redis.flushdb();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await Promise.all([emailQueue.close(), searchSyncQueue.close()]);
  await prisma.$disconnect();
  await redis.quit();
});

const asUser = async (userId: string) => ({
  cookie: `session=${await issueSession(userId)}`,
  'content-type': 'application/json',
});

/** Runs the delivery handler for one email, as the BullMQ worker would. */
async function deliver(emailId: string) {
  const job = {
    data: { emailId },
    attemptsMade: 0,
    opts: { attempts: 5 },
    updateData: async () => undefined,
    moveToDelayed: async () => undefined,
  };
  return processDelivery(job as never, 'token');
}

describe('unsubscribe, bounce and complaint handling', () => {
  it('a GET never unsubscribes; a POST does, and cancels the rest of that recipient', async () => {
    const tenant = await createTenant();
    const { emails } = await createCampaign(tenant, 2);
    const target = emails[0]!;
    const token = unsubscribeToken(target.id);

    const page = await fetch(`${base}/unsubscribe/${token}`);
    expect(page.status).toBe(200);
    expect(await prisma.suppression.count({ where: { userId: tenant.user.id } })).toBe(0);

    // A mail client posts from any origin, with no cookie.
    const post = await fetch(`${base}/unsubscribe/${token}`, {
      method: 'POST',
      headers: {
        origin: 'https://mail.example',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'List-Unsubscribe=One-Click',
    });
    expect(post.status).toBe(200);
    const row = await prisma.suppression.findFirstOrThrow({ where: { userId: tenant.user.id } });
    expect(row).toMatchObject({ email: target.recipient, reason: 'UNSUBSCRIBE' });
    expect((await prisma.email.findUniqueOrThrow({ where: { id: target.id } })).status).toBe(
      'CANCELLED',
    );
    // The other recipient is untouched.
    expect((await prisma.email.findUniqueOrThrow({ where: { id: emails[1]!.id } })).status).toBe(
      'SCHEDULED',
    );
  });

  it('rejects a forged token', async () => {
    const response = await fetch(`${base}/unsubscribe/${'x'.repeat(10)}.forged`);
    expect(response.status).toBe(404);
  });

  it('the worker never sends to a suppressed recipient', async () => {
    const tenant = await createTenant();
    const { emails } = await createCampaign(tenant, 1);
    const email = emails[0]!;
    const headers = await asUser(tenant.user.id);
    const created = await fetch(`${base}/api/suppressions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: email.recipient, reason: 'COMPLAINT' }),
    });
    expect(created.status).toBe(201);
    // Simulate a send that was already past the cancel step.
    await prisma.email.update({ where: { id: email.id }, data: { status: 'SCHEDULED' } });

    await deliver(email.id);
    const after = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
    expect(after.status).toBe('CANCELLED');
    expect(after.attempts).toBe(0);
    expect(after.errorMessage).toContain('suppression list');
    expect(await redis.get(`ri:receipt:${email.id}`)).toBeNull();
  });
});

describe('hard bounces', () => {
  it('fails a 550 at once, never retries, and suppresses the address', async () => {
    const tenant = await createTenant();
    const { emails } = await createCampaign(tenant, 2);
    // Same address twice in one tenant is impossible, so bounce the first and
    // check that the second recipient is still deliverable.
    const bounced = emails[0]!;
    const shared = transportFor({ id: tenant.sender.id, smtpUser: null, smtpPassword: null });
    vi.spyOn(shared, 'sendMail').mockRejectedValueOnce(
      Object.assign(new Error('550 5.1.1 No such user'), { responseCode: 550 }),
    );

    await expect(deliver(bounced.id)).rejects.toThrow(/No such user/);
    const row = await prisma.email.findUniqueOrThrow({ where: { id: bounced.id } });
    expect(row).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect(
      await prisma.suppression.findFirstOrThrow({ where: { userId: tenant.user.id } }),
    ).toMatchObject({ email: bounced.recipient, reason: 'BOUNCE' });
    expect((await prisma.email.findUniqueOrThrow({ where: { id: emails[1]!.id } })).status).toBe(
      'SCHEDULED',
    );
  });
});

describe('per-sender SMTP login', () => {
  it('stores the password encrypted and never returns it', async () => {
    const tenant = await createTenant();
    const headers = await asUser(tenant.user.id);
    const response = await fetch(`${base}/api/senders/${tenant.sender.id}/smtp`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        user: 'own@ethereal.email',
        password: 'hunter2-hunter2',
        verify: false,
      }),
    });
    expect(response.status).toBe(200);
    const stored = await prisma.sender.findUniqueOrThrow({ where: { id: tenant.sender.id } });
    expect(stored.smtpPassword).toMatch(/^enc:v1:/);
    expect(stored.smtpPassword).not.toContain('hunter2');
    expect(decryptSecret(stored.smtpPassword!)).toBe('hunter2-hunter2');

    const list = await (await fetch(`${base}/api/senders`, { headers })).json();
    expect(list.items[0]).toMatchObject({ id: tenant.sender.id, smtpConfigured: true });
    expect(JSON.stringify(list)).not.toContain('hunter2');
  });

  it("refuses to touch another tenant's sender", async () => {
    const owner = await createTenant();
    const intruder = await createTenant('intruder');
    const response = await fetch(`${base}/api/senders/${owner.sender.id}/smtp`, {
      method: 'PUT',
      headers: await asUser(intruder.user.id),
      body: JSON.stringify({ user: 'x', password: 'y', verify: false }),
    });
    expect(response.status).toBe(404);
  });
});

describe('search outbox', () => {
  it('publishes parked email IDs and clears the outbox', async () => {
    const { emails } = await createCampaign(await createTenant(), 3);
    await prisma.searchOutbox.createMany({ data: emails.map((email) => ({ emailId: email.id })) });
    await searchSyncQueue.obliterate({ force: true });

    expect(await drainSearchOutbox()).toBe(3);
    expect(await prisma.searchOutbox.count()).toBe(0);
    const jobs = await searchSyncQueue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs.flatMap((job) => job.data.emailIds).sort()).toEqual(
      emails.map((email) => email.id).sort(),
    );
  });
});

describe('event replay after reconnect', () => {
  it('sends the events a client missed, using Last-Event-ID', async () => {
    const tenant = await createTenant();
    const { publishEvent } = await import('../events/publisher.js');
    for (const count of [1, 2, 3]) {
      publishEvent(tenant.user.id, { type: 'campaign.accepted', campaignId: 'c1', count });
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    const log = await redis.xrange(`ri:eventlog:${tenant.user.id}`, '-', '+');
    expect(log).toHaveLength(3);

    const controller = new AbortController();
    const response = await fetch(`${base}/api/events`, {
      headers: { ...(await asUser(tenant.user.id)), 'last-event-id': log[0]![0] },
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    let text = '';
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !text.includes(log[2]![0])) {
      const { value } = await reader.read();
      text += new TextDecoder().decode(value);
    }
    controller.abort();
    expect(text).toContain(`id: ${log[1]![0]}`);
    expect(text).toContain(`id: ${log[2]![0]}`);
    expect(text).not.toContain(`id: ${log[0]![0]}`);
  });
});
