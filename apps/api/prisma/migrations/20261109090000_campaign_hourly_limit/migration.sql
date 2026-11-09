ALTER TABLE "Campaign" ADD COLUMN "hourlyLimit" INTEGER;
ALTER TABLE "SlackConnection" ADD COLUMN "accessToken" TEXT;
ALTER TABLE "Sender" DROP COLUMN "hourlyLimit";
