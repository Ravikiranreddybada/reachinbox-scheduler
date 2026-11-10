-- Campaign summary columns let the dashboard list campaigns without scanning emails.
ALTER TABLE "Campaign" ADD COLUMN "subject" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Campaign" ADD COLUMN "recipientCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Campaign" ADD COLUMN "startsAt" TIMESTAMP(3);

-- Backfill summaries for campaigns created before this migration.
UPDATE "Campaign" c SET
  "subject" = s."subject",
  "recipientCount" = s."count",
  "startsAt" = s."startsAt"
FROM (
  SELECT "campaignId", MIN("subject") AS "subject", COUNT(*)::int AS "count", MIN("scheduledAt") AS "startsAt"
  FROM "Email" GROUP BY "campaignId"
) s
WHERE s."campaignId" = c."id";

ALTER TABLE "SlackConnection" ADD COLUMN "channelName" TEXT;

-- The Sent view sorts by sentAt; campaign progress groups by status.
CREATE INDEX "Email_userId_status_sentAt_idx" ON "Email"("userId", "status", "sentAt");
DROP INDEX "Email_campaignId_idx";
CREATE INDEX "Email_campaignId_status_idx" ON "Email"("campaignId", "status");
