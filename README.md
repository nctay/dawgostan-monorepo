# Dawgostan Monorepo

Telegram-only архиватор медиа из Twitch и w.tv чатов.

## Структура

- `apps/worker` — ingestion и оркестрация media pipeline.
- `apps/bot` — Telegram admin/public bots.
- `apps/nsfw-ensemble` — production NSFW inference service.
- `apps/api`, `apps/web` — старые web/admin поверхности, сохранённые для совместимости.
- `packages/core` — URL, network security и stream-session правила.
- `packages/nsfw` — извлечение кадров и NSFW-классификация без зависимости от worker env.
- `packages/media-processing` — Telegram-совместимая обработка и сжатие фото, GIF/WebP и видео.

Сборка, проверки и кэш workspace-задач управляются Turborepo:

```bash
pnpm build
pnpm typecheck
pnpm test
```

Схема v1:

- `worker` читает Twitch/w.tv chat, скачивает картинки/видео, дедуплицирует по URL/SHA-256 и сохраняет оригинальное сообщение в приватный Telegram storage-канал.
- `bot` запускает два Telegram-бота: админский для модерации и публичный для просмотра архива.
- `postgres` хранит стримеров, стримы, сообщения, assets, moderation/blocklist.

## Локальный запуск

```bash
pnpm install
cp .env.example .env
pnpm db:generate
docker compose up -d postgres
docker compose run --rm worker pnpm db:migrate
docker compose up --build worker bot
```

В `.env` нужны реальные Twitch и Telegram значения:

```env
DATABASE_URL="postgresql://archive:archive@postgres:5432/archive?schema=public"

TWITCH_CLIENT_ID=""
TWITCH_CLIENT_SECRET=""
TWITCH_EVENTSUB_USER_TOKEN=""
TWITCH_EVENTSUB_USER_ID=""
TWITCH_BOT_USERNAME=""
TWITCH_BOT_OAUTH="oauth:"
TWITCH_CHANNELS="streamer_login"
WTV_CHANNELS="kingkong_movie,mishamedvedka"

TELEGRAM_BOT_TOKEN=""
TELEGRAM_STORAGE_CHAT_ID="-100..."
TELEGRAM_DELETED_CHANNEL_ID="-100..."
TELEGRAM_ALLOWED_USER_IDS="123456789"
TELEGRAM_PUBLIC_BOT_TOKEN=""

TWITCH_CHAT_MESSAGE_RETENTION_MINUTES="120"
MAX_IMAGE_BYTES="31457280"
MAX_VIDEO_BYTES="104857600"
MAX_DAILY_DOWNLOAD_BYTES="10737418240"
MAX_PARALLEL_DOWNLOADS="2"
ALLOW_PRIVATE_MEDIA_HOSTS="false"
```

`WTV_CHANNELS` принимает ники или URL через запятую, например `kingkong_movie,mishamedvedka`.

Обычные YouTube-ссылки и Shorts скачиваются, если ролик не длиннее `MAX_PLATFORM_VIDEO_SECONDS` (по умолчанию 5 минут). Для видео с возрастным ограничением нужен YouTube-аккаунт с подтверждённым возрастом. После деплоя запусти `scripts/setup-youtube-cookies.sh`: он поможет загрузить cookies на VPS и проверит доступ. Файл хранится только в `/srv/chat-meme-scraper/private/youtube-cookies.txt`, не в Git.

Админского и публичного Telegram-ботов добавь в приватный storage-канал, чтобы оба могли делать `copyMessage`.

Для канала удаленных сообщений `TWITCH_EVENTSUB_USER_TOKEN` должен иметь `user:read:chat`, а `TWITCH_EVENTSUB_USER_ID` — Twitch user id этого же чат-аккаунта/бота. Модераторские права не нужны, но Twitch не отдаст имя модератора, который удалил сообщение.
Буфер обычных chat-сообщений хранится только `TWITCH_CHAT_MESSAGE_RETENTION_MINUTES`, по умолчанию 120 минут. Архив удаленных сообщений остается в БД.

## VPS Deploy

GitHub Actions workflow: `.github/workflows/deploy.yml`.

Для нового репозитория deploy включается repository variable `ENABLE_DEPLOY=true`; до этого push запускает только проверки.

На push в `main`/`master` он:

1. ставит зависимости;
2. генерирует Prisma client;
3. запускает typecheck/test/build;
4. билдит `worker` и `bot` Docker images;
5. пушит images в GitHub Container Registry;
6. заходит на VPS по SSH;
7. копирует `docker-compose.prod.yml`;
8. пишет `.env` из GitHub secret `PROD_ENV_B64`;
9. логинится в GHCR;
10. тянет свежие images;
11. применяет миграции;
12. поднимает `postgres`, `worker`, `bot`.

На VPS исходники не нужны. Нужны только Docker, папка приложения, `.env` и `docker-compose.prod.yml`, которые workflow подготовит сам.

Нужные GitHub Secrets:

- `VPS_HOST`
- `VPS_USER`
- `VPS_SSH_KEY`
- `VPS_APP_DIR`, опционально, по умолчанию `/srv/chat-meme-scraper`
- `PROD_ENV_B64`

Сгенерировать `PROD_ENV_B64`:

```bash
base64 -w 0 .env
```

На macOS:

```bash
base64 -i .env | tr -d '\n'
```
