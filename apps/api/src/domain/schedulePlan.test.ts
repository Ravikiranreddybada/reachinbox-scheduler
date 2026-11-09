import { describe, expect, it } from 'vitest';
import { buildSchedulePlan, type SchedulePlanInput } from './schedulePlan.js';

const input: SchedulePlanInput = {
  sender: ' Sender@Example.com ',
  senderName: 'Operations',
  recipients: ['ALICE@example.com', 'alice@example.com', 'bob@example.com'],
  subject: 'Launch',
  body: 'Hello',
  scheduledAt: '2026-10-28T10:00:00.000Z',
  delayBetweenMs: 2_000,
  hourlyLimit: 100,
  idempotencyKey: 'campaign-123',
};

describe('buildSchedulePlan', () => {
  it('normalizes and deduplicates recipients before scheduling', () => {
    const plan = buildSchedulePlan(input);

    expect(plan.emails.map((email) => email.recipient)).toEqual([
      'alice@example.com',
      'bob@example.com',
    ]);
    expect(plan.emails.map((email) => email.scheduledAt.toISOString())).toEqual([
      '2026-10-28T10:00:00.000Z',
      '2026-10-28T10:00:02.000Z',
    ]);
  });

  it('produces stable hashes for safe idempotent replays', () => {
    expect(buildSchedulePlan(input)).toEqual(buildSchedulePlan({ ...input }));
  });

  it('changes the payload fingerprint when meaningful content changes', () => {
    const original = buildSchedulePlan(input);
    const changed = buildSchedulePlan({ ...input, subject: 'Different launch' });

    expect(changed.payloadHash).not.toBe(original.payloadHash);
  });
});
