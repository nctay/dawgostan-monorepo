CREATE TABLE "wtv_redirects" (
  "sessionId" TEXT NOT NULL REFERENCES "stream_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "messageId" TEXT NOT NULL,
  "sourceUrl" TEXT NOT NULL,
  "targetUrl" TEXT NOT NULL,
  PRIMARY KEY ("sessionId", "messageId", "sourceUrl")
);
