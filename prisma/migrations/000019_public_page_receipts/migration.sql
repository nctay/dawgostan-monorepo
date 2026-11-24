BEGIN;
ALTER TABLE "public_bot_updates" ADD COLUMN "pageKey" TEXT;

-- Pending pages written by earlier bots have their Telegram callback in the payload.
-- Keep the oldest request for each page. Later pending clicks only need an ACK.
WITH pages AS (
    SELECT "botId", "updateId", "receivedAt",
           concat_ws(':', coalesce(payload #>> '{callback_query,message,chat,id}', ''),
                          payload #>> '{callback_query,from,id}', payload #>> '{callback_query,data}') AS key
    FROM "public_bot_updates"
    WHERE payload #>> '{callback_query,data}' ~ '^pub:stream:[^:]+:[0-9]+$'
), owners AS (
    SELECT DISTINCT ON ("botId", key) "botId", "updateId", key
    FROM pages
    ORDER BY "botId", key, "receivedAt", "updateId"
)
UPDATE "public_bot_updates" u SET "pageKey" = owners.key
FROM owners WHERE u."botId" = owners."botId" AND u."updateId" = owners."updateId";

CREATE UNIQUE INDEX "public_bot_updates_botId_pageKey_key" ON "public_bot_updates" ("botId", "pageKey");
COMMIT;
