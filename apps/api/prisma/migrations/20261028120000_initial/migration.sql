CREATE TYPE "EmailStatus" AS ENUM ('SCHEDULED', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED');

CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "googleId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Sender" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "hourlyLimit" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Sender_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Email" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "status" "EmailStatus" NOT NULL DEFAULT 'SCHEDULED',
    "errorMessage" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "processingStartedAt" TIMESTAMP(3),
    "providerMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Email_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SlackConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "teamName" TEXT,
    "webhookUrl" TEXT NOT NULL,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SlackConnection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE INDEX "Campaign_userId_createdAt_idx" ON "Campaign"("userId", "createdAt");
CREATE UNIQUE INDEX "Campaign_userId_idempotencyKey_key" ON "Campaign"("userId", "idempotencyKey");
CREATE INDEX "Sender_userId_idx" ON "Sender"("userId");
CREATE UNIQUE INDEX "Sender_userId_email_key" ON "Sender"("userId", "email");
CREATE INDEX "Email_userId_status_scheduledAt_idx" ON "Email"("userId", "status", "scheduledAt");
CREATE INDEX "Email_senderId_status_scheduledAt_idx" ON "Email"("senderId", "status", "scheduledAt");
CREATE INDEX "Email_status_processingStartedAt_idx" ON "Email"("status", "processingStartedAt");
CREATE INDEX "Email_campaignId_idx" ON "Email"("campaignId");
CREATE UNIQUE INDEX "Email_userId_idempotencyKey_key" ON "Email"("userId", "idempotencyKey");
CREATE UNIQUE INDEX "SlackConnection_userId_key" ON "SlackConnection"("userId");

ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Sender" ADD CONSTRAINT "Sender_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Email" ADD CONSTRAINT "Email_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Email" ADD CONSTRAINT "Email_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "Sender"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Email" ADD CONSTRAINT "Email_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SlackConnection" ADD CONSTRAINT "SlackConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
