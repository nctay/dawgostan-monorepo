-- The legacy timestamp also represented unconfirmed reservations.
-- Keep its 48-hour guard and record confirmation only after a successful send.
ALTER TABLE "assets" ADD COLUMN "publicTelegramConfirmedAt" TIMESTAMP(3);
