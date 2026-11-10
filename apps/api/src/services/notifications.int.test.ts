import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptSecret } from '../lib/crypto.js';
import { prisma, redis } from '../lib/infra.js';
import { notifyQuotaReached, type QuotaAlert } from './notifications.js';

const WEBHOOK = 'https://hooks.slack.test/services/T000/B000/secret';
const alert: QuotaAlert = {
  userId: 'slack-test-user',
  senderEmail: 'sender@example.com',
  campaignId: 'camp-1',
  scope: 'sender',
  limit: 2,
  window: 495_000,
  resumesAt: Date.parse('2026-11-10T08:00:00Z'),
};

async function connect() {
  await prisma.user.upsert({
    where: { id: alert.userId },
    update: {},
    create: { id: alert.userId, email: 'slack-test@example.com', name: 'Slack Test' },
  });
  await prisma.slackConnection.upsert({
    where: { userId: alert.userId },
    update: { webhookUrl: encryptSecret(WEBHOOK) },
    create: { userId: alert.userId, teamId: 'T000', webhookUrl: encryptSecret(WEBHOOK) },
  });
}

beforeEach(async () => {
  await redis.flushdb();
  await connect();
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: alert.userId } });
  await prisma.$disconnect();
  await redis.quit();
});

describe('notifyQuotaReached (real Redis + Postgres, fake Slack)', () => {
  it('posts one message to the decrypted webhook and dedupes within the hour', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    await notifyQuotaReached(alert);
    await notifyQuotaReached(alert);
    await Promise.all([notifyQuotaReached(alert), notifyQuotaReached(alert)]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(WEBHOOK);
    const text = JSON.parse(init.body as string).text as string;
    expect(text).toContain('sender@example.com');
    expect(text).toContain('hourly limit of 2');
    expect(text).toContain('2026-11-10T08:00:00Z');
  });

  it('sends nothing when Slack is disconnected', async () => {
    await prisma.slackConnection.delete({ where: { userId: alert.userId } });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await notifyQuotaReached(alert);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('alerts after connecting later in the same hour as a skipped alert', async () => {
    await prisma.slackConnection.delete({ where: { userId: alert.userId } });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    await notifyQuotaReached(alert);
    expect(fetchMock).not.toHaveBeenCalled();
    await connect();
    await notifyQuotaReached(alert);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('alerts again after reconnect in a new hour', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    await notifyQuotaReached(alert);
    await notifyQuotaReached({ ...alert, window: alert.window + 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('releases the dedupe key when Slack fails so a later job can retry', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    await expect(notifyQuotaReached(alert)).rejects.toThrow('Slack webhook returned 500');
    await notifyQuotaReached(alert);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
