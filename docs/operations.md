# Эксплуатация

## Локально

Нужны Node.js 24, pnpm 10.12.1/Corepack, Docker. Worker image содержит ffmpeg, ffprobe, ImageMagick, Python, pinned yt-dlp.

```bash
pnpm install
cp .env.example .env
pnpm db:generate
docker compose up -d postgres nsfw-ensemble
docker compose run --rm worker pnpm db:migrate
docker compose up --build worker bot
```

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Worker отдельно:

```bash
pnpm --filter @dawgostan/core build
pnpm --filter worker typecheck
pnpm --filter worker test
pnpm --filter worker build
```

Если worker не находит workspace package, сначала собери пакет или запусти root Turbo command.

## CI/CD

`.github/workflows/deploy.yml` работает на push/PR в `main`/`master`. Verify: frozen install, Prisma generate, typecheck, tests, build. Deploy только на push при `ENABLE_DEPLOY=true`: публикует `worker`, `bot`, `nsfw-ensemble` в GHCR, копирует compose, восстанавливает env/cookies, применяет migrations, запускает `up -d --remove-orphans`.

Docker BuildKit cache хранится в GitHub Actions отдельно для каждого образа. Перед скачиванием новых образов и после успешного запуска deploy удаляет только неиспользуемые Docker-образы; запущенные контейнеры и volumes, включая PostgreSQL, не затрагиваются.

При включённом deploy любой main push, включая docs-only, запускает production rollout.

## VPS

```bash
cd /srv/chat-meme-scraper
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs --tail=200 worker bot nsfw-ensemble
docker compose -f docker-compose.prod.yml logs -f worker bot
docker compose -f docker-compose.prod.yml run --rm worker pnpm db:migrate
```

Не выполнять `down -v`, `docker volume rm`, удаление `postgres-data`, пересоздание PostgreSQL. `up -d` сохраняет volume.

## Мониторинг

Grafana Alloy отправляет в Grafana Cloud метрики VPS и Docker, а также логи `worker`, `bot`, `nsfw-ensemble` и PostgreSQL. Alloy UI наружу не публикуется.

```bash
docker compose -f docker-compose.prod.yml ps alloy
docker compose -f docker-compose.prod.yml logs --tail=100 alloy
```

В Grafana Cloud установи integrations `Linux Server`, `Docker` и `Alloy Health`, чтобы получить готовые dashboards и базовые alerts.

## Backup PostgreSQL

```bash
cd /srv/chat-meme-scraper
mkdir -p backups
backup_file="backups/archive-$(date +%F-%H%M%S).dump"
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U archive -d archive -Fc > "$backup_file"
test -s "$backup_file"
ls -lh "$backup_file"
```

Restore не автоматизирован: он перезаписывает данные и требует отдельного плана.

## VOD recovery

Скрипт создаёт `ChatPost`, `Asset`, `DownloadJob`; worker скачивает и публикует. Default — dry-run.

```bash
docker compose -f docker-compose.prod.yml run --rm \
  -e RECOVERY_VOD_ID=2792466641 \
  -e RECOVERY_FROM='2026-06-09T18:57:00+03:00' \
  -e RECOVERY_TO='2026-06-09T19:56:00+03:00' \
  worker node apps/worker/dist/scripts/recover-vod-chat.js
```

После проверки статистики добавь `-e RECOVERY_DRY_RUN=false`. `RECOVERY_PAGE_STEP_SECONDS` default 30; timestamps ISO, `TO > FROM`.

## Bots

Admin: `/start`, `/live`, `/streams`, `/latest`, `/stream <id>`. Callbacks скрывают asset или удаляют с добавлением в blocklist. Public bot показывает stored/public assets, private streamers доступны только admins.

## Troubleshooting

SSH deploy:

1. проверить `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`;
2. проверить Docker-права deploy user;
3. проверить доступ к `/srv/chat-meme-scraper`;
4. при необходимости запустить `VPS diagnostics`.

Worker:

1. найти `ignored offline media`, `blocked`, `failed`, `daily limit` в логах;
2. проверить live/grace session;
3. проверить platform downloads, лимиты, cookies;
4. проверить доступ бота к Telegram channels;
5. не чистить queue/volume до диагноза.

NSFW:

```bash
docker compose -f docker-compose.prod.yml ps nsfw-ensemble
docker compose -f docker-compose.prod.yml logs --tail=200 nsfw-ensemble worker
```

Ошибка classifier не теряет asset: public copy получает spoiler.

YouTube age restriction:

```bash
scripts/setup-youtube-cookies.sh
```

CI использует `YOUTUBE_COOKIES_B64`; cookies не попадают в Git/Actions output.
