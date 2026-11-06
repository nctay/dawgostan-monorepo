-- CreateEnum
CREATE TYPE "ConversionStatus" AS ENUM ('pending', 'downloading', 'storing', 'delivering', 'done', 'failed', 'uncertain');

-- CreateTable
CREATE TABLE "converter_users" (
    "username" TEXT NOT NULL,
    "telegramUserId" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "converter_users_pkey" PRIMARY KEY ("username")
);

-- CreateTable
CREATE TABLE "conversion_requests" (
    "id" TEXT NOT NULL,
    "ownerId" BIGINT NOT NULL,
    "telegramUpdateId" INTEGER NOT NULL,
    "chatId" BIGINT NOT NULL,
    "sourceMessageId" INTEGER NOT NULL,
    "originalUrl" TEXT NOT NULL,
    "normalizedUrl" TEXT NOT NULL,
    "status" "ConversionStatus" NOT NULL DEFAULT 'pending',
    "byteSize" BIGINT,
    "sha256" TEXT,
    "botKey" TEXT,
    "telegramFileId" TEXT,
    "storageMessageId" INTEGER,
    "telegramMessageId" INTEGER,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversion_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "converter_users_telegramUserId_key" ON "converter_users"("telegramUserId");

-- CreateIndex
CREATE UNIQUE INDEX "conversion_requests_telegramUpdateId_key" ON "conversion_requests"("telegramUpdateId");

-- CreateIndex
CREATE INDEX "conversion_requests_status_createdAt_idx" ON "conversion_requests"("status", "createdAt");

-- CreateIndex
CREATE INDEX "conversion_requests_ownerId_createdAt_idx" ON "conversion_requests"("ownerId", "createdAt");

CREATE INDEX "conversion_requests_botKey_sha256_idx" ON "conversion_requests"("botKey", "sha256");

-- AddForeignKey
ALTER TABLE "conversion_requests" ADD CONSTRAINT "conversion_requests_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "converter_users"("telegramUserId") ON DELETE RESTRICT ON UPDATE CASCADE;
