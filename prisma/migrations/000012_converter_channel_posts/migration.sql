ALTER TABLE "conversion_requests"
  ALTER COLUMN "ownerId" DROP NOT NULL,
  ADD COLUMN "channelPostKey" TEXT,
  ADD COLUMN "sourcePostedAt" TIMESTAMP(3),
  ADD COLUMN "caption" TEXT,
  ADD COLUMN "captionLinkOffset" INTEGER,
  ADD COLUMN "telegramMediaKind" TEXT;

CREATE UNIQUE INDEX "conversion_requests_channelPostKey_key" ON "conversion_requests"("channelPostKey");
