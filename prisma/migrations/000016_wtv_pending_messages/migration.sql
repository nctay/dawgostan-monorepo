CREATE TABLE "wtv_pending_messages" (
  "sessionId" TEXT NOT NULL REFERENCES "stream_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "messageId" TEXT NOT NULL,
  "sourceUrls" TEXT[] NOT NULL,
  "authorName" TEXT NOT NULL,
  "authorTwitchId" TEXT,
  "messageText" TEXT NOT NULL,
  "postedAt" TIMESTAMP(3) NOT NULL,
  "lastAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("sessionId", "messageId")
);

CREATE INDEX "wtv_pending_messages_sessionId_lastAttemptAt_idx" ON "wtv_pending_messages" ("sessionId", "lastAttemptAt");
