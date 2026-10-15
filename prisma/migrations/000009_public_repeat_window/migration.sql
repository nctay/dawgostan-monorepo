ALTER TABLE "assets"
ADD COLUMN "publicTelegramPublishedAt" TIMESTAMP(3);

UPDATE "assets"
SET "publicTelegramPublishedAt" = "updatedAt"
WHERE "publicTelegramMessageId" IS NOT NULL;
