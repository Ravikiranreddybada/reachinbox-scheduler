-- Body once per campaign; list preview; per-sender SMTP; suppressions; search outbox.
CREATE TYPE "SuppressionReason" AS ENUM ('UNSUBSCRIBE', 'BOUNCE', 'COMPLAINT');

ALTER TABLE "Campaign" ADD COLUMN "body" TEXT, ADD COLUMN "preview" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Sender" ADD COLUMN "smtpUser" TEXT, ADD COLUMN "smtpPassword" TEXT;
ALTER TABLE "Email" ALTER COLUMN "body" DROP NOT NULL;

-- Move existing bodies up to their campaign, then drop the per-row copies.
UPDATE "Campaign" c
SET "body" = e."body",
    "preview" = left(btrim(regexp_replace(regexp_replace(e."body", '<[^>]*>', ' ', 'g'), '\s+', ' ', 'g')), 140)
FROM (SELECT DISTINCT ON ("campaignId") "campaignId", "body" FROM "Email" ORDER BY "campaignId", "createdAt") e
WHERE e."campaignId" = c."id";
UPDATE "Email" SET "body" = NULL WHERE "campaignId" IN (SELECT "id" FROM "Campaign" WHERE "body" IS NOT NULL);

CREATE INDEX "Email_status_scheduledAt_idx" ON "Email"("status", "scheduledAt");

CREATE TABLE "Suppression" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "reason" "SuppressionReason" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Suppression_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Suppression_userId_email_key" ON "Suppression"("userId", "email");
ALTER TABLE "Suppression" ADD CONSTRAINT "Suppression_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SearchOutbox" (
    "id" SERIAL NOT NULL,
    "emailId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SearchOutbox_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SearchOutbox_emailId_key" ON "SearchOutbox"("emailId");
