ALTER TABLE "wtv_pending_messages"
  ADD COLUMN "skipTelegramPublic" BOOLEAN NOT NULL DEFAULT FALSE;
