BEGIN;

CREATE TABLE "wtv_message_owners" (
  "messageId" TEXT PRIMARY KEY,
  "sessionId" TEXT NOT NULL REFERENCES "stream_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "skipTelegramPublic" BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX "wtv_message_owners_sessionId_idx" ON "wtv_message_owners" ("sessionId");

-- Older archive posts stored the WTV ID in the per-URL deduplication key alone.
UPDATE "chat_posts"
SET "rawTwitchMessageId" = regexp_replace("twitchMessageId", ':https?://.*$', '', 'i')
WHERE "rawTwitchMessageId" IS NULL AND "twitchMessageId" LIKE 'wtv:%';

-- An old installation can have a post, an unresolved message, or only a pinned hop.
-- If an ID was already reused, retain its earliest broadcast and any recorded privacy tag.
WITH history AS (
  SELECT "rawTwitchMessageId" AS id,
         "streamSessionId" AS session, "skipTelegramPublic" AS private, "messageText" AS content
  FROM "chat_posts"
  WHERE "rawTwitchMessageId" LIKE 'wtv:%'
  UNION ALL
  SELECT "messageId", "sessionId", "skipTelegramPublic", "messageText" FROM "wtv_pending_messages"
  UNION ALL
  SELECT "messageId", "sessionId", false, NULL FROM "wtv_redirects"
)
INSERT INTO "wtv_message_owners" ("messageId", "sessionId", "skipTelegramPublic")
SELECT DISTINCT ON (h.id) h.id, h.session,
       bool_or(h.private OR COALESCE(h.content ~* U&'!skip_tg(https?://|www[.]|[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]|$)', false)) OVER (PARTITION BY h.id)
FROM history h JOIN "stream_sessions" s ON s.id = h.session
ORDER BY h.id, s."startedAt", h.session;

UPDATE "chat_posts" p
SET "skipTelegramPublic" = true, "publicRetryAt" = NULL
FROM "wtv_message_owners" o
WHERE p."rawTwitchMessageId" = o."messageId"
  AND (p."streamSessionId" <> o."sessionId" OR o."skipTelegramPublic")
  AND (NOT p."skipTelegramPublic" OR p."publicRetryAt" IS NOT NULL);

-- A legacy retry from a later broadcast must not occupy a retry slot indefinitely.
DELETE FROM "wtv_pending_messages" p USING "wtv_message_owners" o
WHERE p."messageId" = o."messageId" AND p."sessionId" <> o."sessionId";
DELETE FROM "wtv_redirects" r USING "wtv_message_owners" o
WHERE r."messageId" = o."messageId" AND r."sessionId" <> o."sessionId";

COMMIT;
