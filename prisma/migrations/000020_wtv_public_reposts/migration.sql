ALTER TABLE "chat_posts"
  ADD COLUMN "publicRetryAt" TIMESTAMP(3),
  ADD COLUMN "publicClaimedAt" TIMESTAMP(3),
  ADD COLUMN "publicFileOffset" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "chat_posts_public_retry_idx" ON "chat_posts" ("publicRetryAt", "id") WHERE "publicRetryAt" IS NOT NULL;
