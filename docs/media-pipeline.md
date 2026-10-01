# Media pipeline

## 1. Сессия

Twitch status берётся из Helix, w.tv — из profile/channel API. Offline ставит `endedAt`, но session остаётся `live` 30 минут. Reconnect внутри окна очищает `endedAt`; после окна status становится `ended`. Без active/grace session сообщение не создаёт `ChatPost` или `DownloadJob`.

## 2. Фильтры

До извлечения URL отбрасываются:

- `!sr` в начале сообщения;
- отдельный маркер `catAsk`;
- авторы `Nightbot`, `StreamElements`;
- w.tv markers `GSS-media`, `ME-*`.

`!skip_tg` удаляется из текста и ставит `skipTelegramPublic=true`: storage/БД сохраняются, public channel/bot пропускаются.

## 3. URL и безопасность

Поддержка:

- jpg/jpeg/png/gif/webp/avif, mp4/webm/mov;
- Discord CDN без расширения;
- Twitch Clips, TikTok, YouTube watch/Shorts/youtu.be;
- Postimages, ImgBB, eblo.id, Yandex Disk `/i/...` и `/d/...`;
- `clck.su`, `clck.ru`, `bit.ly`, `tinyurl.com` с поддерживаемым target.

Нормализация убирает fragment/default port, приводит hostname к lower-case, канонизирует Twitch Clips/Yandex Disk, чистит Discord query params.

Все redirects и DNS addresses проходят SSRF-защиту: только HTTP(S), без localhost/private/local/reserved IP. `ALLOW_PRIVATE_MEDIA_HOSTS=true` отключает DNS-проверку; в production не использовать без причины.

## 4. Очередь и дедупликация

Проверки: blocked normalized URL, stored asset по URL, скачивание/SHA-256, blocked SHA, stored asset по SHA. Повтор переиспользует Telegram message.

Jobs забираются через `FOR UPDATE SKIP LOCKED`; SHA lock не даёт двум слотам сохранить одинаковые bytes. Максимум 3 попытки: первые две возвращают `pending` с задержкой, третья ставит job/post/asset в `failed`. Дневной лимит считает stored bytes после полуночи worker.

## 5. Скачивание и обработка

Прямое медиа: HEAD, затем streaming GET с byte counter. Defaults: 30 MiB image, 100 MiB video.

`yt-dlp`: без playlist, до `MAX_PLATFORM_VIDEO_SECONDS` (default 300), проверка известного размера до скачивания, итоговый MP4. Age-restricted YouTube использует `/run/private/youtube-cookies.txt`.

Telegram normalization:

- GIF/animated WebP конвертируются в MP4 и отправляются через `sendAnimation`;
- фото resize/pad через ImageMagick;
- видео конвертируется в H.264/yuv420p + AAC с `faststart`;
- видео больше 49.9 MB сжимается two-pass;
- `ffprobe` добавляет width/height/duration.

## 6. NSFW

Image использует 1 кадр; video/animation — до `NSFW_MAX_FRAMES`. Spoiler включается, если Owen или SigLIP score достигает `NSFW_ENSEMBLE_THRESHOLD`. Ошибка/timeout/invalid response тоже включает spoiler. Без classifier URL проверка выключена.

## 7. Telegram

Файл сначала отправляется в private storage с streamer/session/asset/SHA-256/URL; Telegram IDs сохраняются в `Asset`.

Public channel получает media, только если настроен, asset public, нет `!skip_tg`, streamer не private, `publicTelegramMessageId` отсутствует.

```text
#streamer_stream #date_YYYY_MM_DD #user_sender
```

Текст без URL добавляется после `:`; без текста colon отсутствует. Caption до 1000 символов, дата `Europe/Moscow`.

## 8. Deleted messages и moderation

EventSub `channel.chat.message_delete` сопоставляется с временным `TwitchChatMessage`. Buffer живёт `TWITCH_CHAT_MESSAGE_RETENTION_MINUTES`; `DeletedChatMessage` хранится постоянно. Private/hidden/`!skip_tg` не публикуются.

Admin-бот скрывает asset или удаляет из storage. Удаление ставит `deleted + hidden` и блокирует URL/SHA, предотвращая повторное сохранение.
