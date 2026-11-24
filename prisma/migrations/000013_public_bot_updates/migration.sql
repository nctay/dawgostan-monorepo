CREATE TABLE "public_bot_updates" (
    "botId" BIGINT NOT NULL,
    "updateId" INTEGER NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB,
    PRIMARY KEY ("botId", "updateId")
);

CREATE INDEX "public_bot_updates_botId_receivedAt_idx" ON "public_bot_updates" ("botId", "receivedAt");
