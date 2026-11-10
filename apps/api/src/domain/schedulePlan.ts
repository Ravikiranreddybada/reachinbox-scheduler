import { createHash } from 'node:crypto';

export interface SchedulePlanInput {
  sender: string;
  senderName?: string;
  recipients: string[];
  subject: string;
  body: string;
  scheduledAt: string;
  delayBetweenMs: number;
  hourlyLimit?: number;
  attachmentIds?: string[];
  idempotencyKey: string;
}

export interface PlannedEmail {
  recipient: string;
  scheduledAt: Date;
  idempotencyKey: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function buildSchedulePlan(input: SchedulePlanInput): {
  payloadHash: string;
  emails: PlannedEmail[];
} {
  const sender = input.sender.trim().toLowerCase();
  const recipients = [...new Set(input.recipients.map((value) => value.trim().toLowerCase()))];
  const start = new Date(input.scheduledAt);

  const canonicalPayload = JSON.stringify({
    sender,
    senderName: input.senderName?.trim() || null,
    recipients,
    subject: input.subject,
    body: input.body,
    scheduledAt: start.toISOString(),
    delayBetweenMs: input.delayBetweenMs,
    hourlyLimit: input.hourlyLimit ?? null,
    // Only present when used, so payloads without attachments keep their old hash.
    ...(input.attachmentIds?.length ? { attachmentIds: [...input.attachmentIds].sort() } : {}),
  });

  return {
    payloadHash: sha256(canonicalPayload),
    emails: recipients.map((recipient, index) => ({
      recipient,
      scheduledAt: new Date(start.getTime() + index * input.delayBetweenMs),
      idempotencyKey: sha256(`${input.idempotencyKey}\0${recipient}`),
    })),
  };
}
