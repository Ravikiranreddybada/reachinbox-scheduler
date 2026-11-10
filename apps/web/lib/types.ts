export type User = {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string | null;
  slackConnection?: { teamName?: string | null; channelName?: string | null } | null;
};
export type EmailStatus = 'SCHEDULED' | 'PROCESSING' | 'SENT' | 'FAILED' | 'CANCELLED';
export type Email = {
  id: string;
  recipient: string;
  subject: string;
  /** Short plain-text preview. Search results mark matches with \u0002 and \u0003. */
  preview: string;
  scheduledAt: string;
  sentAt?: string | null;
  status: EmailStatus;
  errorMessage?: string | null;
  attempts?: number;
  starred: boolean;
};
export type AttachmentInfo = { id: string; filename: string; contentType: string; size: number };
export type EmailDetail = Omit<Email, 'preview'> & {
  body: string;
  campaignId: string;
  sender: { email: string; displayName?: string | null };
  attachments: AttachmentInfo[];
};
export type Mailbox = 'scheduled' | 'sent';
export type Stats = {
  scheduled: number;
  processing: number;
  sent: number;
  failed: number;
  cancelled: number;
};
export type SchedulePayload = {
  sender: string;
  senderName: string;
  recipients: string[];
  subject: string;
  body: string;
  scheduledAt: string;
  delayBetweenMs: number;
  hourlyLimit?: number;
  attachmentIds: string[];
  idempotencyKey: string;
};
