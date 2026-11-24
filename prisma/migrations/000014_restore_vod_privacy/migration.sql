-- Match both generations of VOD IDs and the same whitespace as the chat tag parser.
UPDATE "chat_posts" SET "skipTelegramPublic" = TRUE
WHERE ("rawTwitchMessageId" LIKE 'vod:%' OR "twitchMessageId" LIKE 'vod:%')
  AND NOT "skipTelegramPublic"
  AND "messageText" ~* U&'!skip_tg(https?://|www[.]|[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]|$)';
