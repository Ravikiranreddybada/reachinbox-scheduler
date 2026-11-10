import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCampaign, createTenant } from '../../test/fixtures.js';
import { createApp } from '../app.js';
import { issueSession } from '../lib/auth.js';
import { prisma, redis } from '../lib/infra.js';
import { emailQueue, searchSyncQueue } from '../queues/emailQueue.js';

let server: Server;
let base: string;
let cookie: string;
let other: string;
let tenant: Awaited<ReturnType<typeof createTenant>>;

beforeAll(async () => {
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  tenant = await createTenant('mail');
  cookie = `session=${await issueSession(tenant.user.id)}`;
  const stranger = await createTenant('stranger');
  other = `session=${await issueSession(stranger.user.id)}`;
});
afterAll(async () => {
  server.close();
  await Promise.all([emailQueue.close(), searchSyncQueue.close()]);
  await prisma.$disconnect();
  await redis.quit();
});

const call = (path: string, init: RequestInit = {}, session = cookie) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', cookie: session, ...init.headers },
  });

describe('email + password login', () => {
  const email = `login-${randomUUID().slice(0, 8)}@example.com`;
  const login = (password: string) =>
    fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

  it('signs an unknown address up, then requires the same password', async () => {
    const created = await login('correct-horse');
    expect(created.status).toBe(201);
    expect(created.headers.get('set-cookie')).toMatch(/session=/);
    expect((await login('correct-horse')).status).toBe(200);
    const wrong = await login('wrong-password');
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('set-cookie')).toBeNull();
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.passwordHash).toMatch(/^scrypt:v1:/);
    expect(user.passwordHash).not.toContain('correct-horse');
  });

  it('rejects short passwords and malformed emails', async () => {
    expect((await login('short')).status).toBe(400);
    const bad = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nope', password: 'long-enough-1' }),
    });
    expect(bad.status).toBe(400);
  });
});

describe('star, archive and delete', () => {
  it('stars and archives, and archived mail leaves the list and stats', async () => {
    const { emails } = await createCampaign(tenant, 1, {
      scheduledAt: new Date(Date.now() + 3_600_000),
    });
    const id = emails[0]!.id;
    const starred = await call(`/api/emails/${id}`, { method: 'PATCH', body: '{"starred":true}' });
    expect((await starred.json()).starred).toBe(true);
    await call(`/api/emails/${id}`, { method: 'PATCH', body: '{"archived":true}' });
    const list = await (await call('/api/emails?status=SCHEDULED')).json();
    expect(list.items.some((item: { id: string }) => item.id === id)).toBe(false);
    const archived = await (await call('/api/emails?status=SCHEDULED&archived=true')).json();
    expect(archived.items.some((item: { id: string }) => item.id === id)).toBe(true);
    await call(`/api/emails/${id}`, { method: 'PATCH', body: '{"archived":false}' });
    const back = await (await call('/api/emails?status=SCHEDULED&starred=true')).json();
    expect(back.items.some((item: { id: string }) => item.id === id)).toBe(true);
  });

  it('delete cancels a scheduled email first and hides it', async () => {
    const { emails } = await createCampaign(tenant, 1, {
      scheduledAt: new Date(Date.now() + 3_600_000),
    });
    const id = emails[0]!.id;
    expect((await call(`/api/emails/${id}`, { method: 'DELETE' })).status).toBe(204);
    const row = await prisma.email.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('CANCELLED');
    expect(row.deletedAt).not.toBeNull();
    expect((await call(`/api/emails/${id}`)).status).toBe(404);
  });

  it('refuses to delete an email that is being sent', async () => {
    const { emails } = await createCampaign(tenant, 1);
    await prisma.email.update({ where: { id: emails[0]!.id }, data: { status: 'PROCESSING' } });
    expect((await call(`/api/emails/${emails[0]!.id}`, { method: 'DELETE' })).status).toBe(409);
  });

  it("does not let one user touch another user's email", async () => {
    const { emails } = await createCampaign(tenant, 1);
    const id = emails[0]!.id;
    expect((await call(`/api/emails/${id}`, { method: 'DELETE' }, other)).status).toBe(404);
    expect(
      (await call(`/api/emails/${id}`, { method: 'PATCH', body: '{"starred":true}' }, other))
        .status,
    ).toBe(404);
  });
});

describe('attachments', () => {
  const upload = (data: string, session = cookie, name = 'notes.txt') =>
    fetch(`${base}/api/attachments`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        'x-filename': encodeURIComponent(name),
        cookie: session,
      },
      body: data,
    });

  it('uploads, downloads as an attachment, and is private to its owner', async () => {
    const created = await (await upload('hello')).json();
    expect(created).toMatchObject({ filename: 'notes.txt', size: 5 });
    const file = await call(`/api/attachments/${created.id}`);
    expect(file.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(await file.text()).toBe('hello');
    expect((await call(`/api/attachments/${created.id}`, {}, other)).status).toBe(404);
  });

  it('links to the campaign at schedule time and shows on the email', async () => {
    const created = await (await upload('payload', cookie, 'brief.txt')).json();
    const response = await call('/api/emails', {
      method: 'POST',
      body: JSON.stringify({
        sender: 'ops@example.com',
        recipients: ['att@example.com'],
        subject: 'With file',
        body: '<p>See <b>attached</b><script>alert(1)</script></p>',
        scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
        delayBetweenMs: 0,
        attachmentIds: [created.id],
        idempotencyKey: `att-${randomUUID()}`,
      }),
    });
    expect(response.status).toBe(202);
    const { items } = await (await call('/api/emails?status=SCHEDULED&limit=100')).json();
    const mine = items.find((item: { subject: string }) => item.subject === 'With file');
    const detail = await (await call(`/api/emails/${mine.id}`)).json();
    expect(detail.attachments).toEqual([
      expect.objectContaining({ id: created.id, filename: 'brief.txt' }),
    ]);
    expect(detail.body).not.toMatch(/script/);
    expect((await call(`/api/attachments/${created.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it("rejects another user's attachment id when scheduling", async () => {
    const theirs = await (await upload('secret', other)).json();
    const response = await call('/api/emails', {
      method: 'POST',
      body: JSON.stringify({
        sender: 'ops@example.com',
        recipients: ['x@example.com'],
        subject: 'Steal',
        body: 'Hi',
        scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
        delayBetweenMs: 0,
        attachmentIds: [theirs.id],
        idempotencyKey: `steal-${randomUUID()}`,
      }),
    });
    expect(response.status).toBe(422);
  });

  it('deletes only unsent attachments', async () => {
    const created = await (await upload('temp')).json();
    expect((await call(`/api/attachments/${created.id}`, { method: 'DELETE' })).status).toBe(204);
  });
});
