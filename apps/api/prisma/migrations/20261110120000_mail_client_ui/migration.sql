-- Email/password accounts: a user may have no Google identity.
ALTER TABLE "User" ALTER COLUMN "googleId" DROP NOT NULL;
ALTER TABLE "User" ADD COLUMN "passwordHash" TEXT;

-- Mail-client actions: star, archive, soft delete.
ALTER TABLE "Email" ADD COLUMN "starred" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Email" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "Email" ADD COLUMN "deletedAt" TIMESTAMP(3);
CREATE INDEX "Email_userId_deletedAt_archivedAt_idx" ON "Email"("userId", "deletedAt", "archivedAt");

-- Attachments, stored in PostgreSQL and linked to a campaign when scheduled.
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "campaignId" TEXT,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Attachment_userId_campaignId_idx" ON "Attachment"("userId", "campaignId");
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
