# Конфигурация

Не копируй секреты в docs, issues, Actions logs или Git. `.gitignore` исключает `.env`, `.env.*`, `private/`; tracked только `.env.example`.

Compose читает `.env`. `.env.prod` и `.env.notification` могут быть локальными копиями, но автоматически не загружаются.

## Основные env

| Переменная | Сервис | Назначение |
| --- | --- | --- |
| `DATABASE_URL` | worker, bot | PostgreSQL |
| `TWITCH_CLIENT_ID` | worker | Helix/EventSub client |
| `TWITCH_CLIENT_SECRET` | worker | App token |
| `TWITCH_CHANNELS` | worker | Twitch logins через запятую |
| `TELEGRAM_BOT_TOKEN` | worker, bot | Storage/admin bot |
| `TELEGRAM_STORAGE_CHAT_ID` | worker, bot | Private storage channel |
| `TELEGRAM_ALLOWED_USER_IDS` | bot | Admin user IDs |

Worker schema требует только `DATABASE_URL`, но без Twitch/Telegram env соответствующие части не работают. Bot требует `DATABASE_URL`, bot token, storage ID, allowed IDs.

## Чат и visibility

| Переменная | Default | Назначение |
| --- | --- | --- |
| `TWITCH_BOT_USERNAME` + `TWITCH_BOT_OAUTH` | — | Authenticated Twitch chat; без пары anonymous |
| `TWITCH_EVENTSUB_USER_TOKEN` | — | Token со scope `user:read:chat` |
| `TWITCH_EVENTSUB_USER_ID` | — | ID того же Twitch account |
| `WTV_CHANNELS` | пусто | w.tv nickname, UUID или URL |
| `TWITCH_CHAT_MESSAGE_RETENTION_MINUTES` | `120` | Delete-event buffer |
| `TELEGRAM_PUBLIC_CHANNEL_ID` | — | Автопубликация assets |
| `TELEGRAM_DELETED_CHANNEL_ID` | — | Deleted-message channel |
| `TELEGRAM_PUBLIC_BOT_TOKEN` | — | Public archive bot |
| `TELEGRAM_PRIVATE_STREAMER_LOGINS` | пусто | Logins, скрытые из public surfaces |

Оба бота получают доступ к private storage для `copyMessage`. `nctay` — приватный production test streamer.

## Download и NSFW

| Переменная | Default | Назначение |
| --- | --- | --- |
| `MAX_IMAGE_BYTES` | `31457280` | Лимит изображения |
| `MAX_VIDEO_BYTES` | `104857600` | Лимит видео |
| `MAX_DAILY_DOWNLOAD_BYTES` | `10737418240` | Stored bytes после полуночи worker |
| `MAX_PARALLEL_DOWNLOADS` | `2` | Параллельные jobs |
| `ALLOW_PRIVATE_MEDIA_HOSTS` | `false` | Private DNS/IP; в production оставить `false` |
| `ENABLE_PLATFORM_DOWNLOADS` | `false` | yt-dlp; example включает явно |
| `MAX_PLATFORM_VIDEO_SECONDS` | `300` | Лимит длительности |
| `PLATFORM_DOWNLOAD_TIMEOUT_MS` | `600000` | yt-dlp/ffmpeg/ImageMagick timeout |
| `NSFW_ENSEMBLE_CLASSIFIER_URL` | — | Обычно `http://nsfw-ensemble:3333/classify` |
| `NSFW_ENSEMBLE_THRESHOLD` | `0.8` | Owen/SigLIP spoiler threshold |
| `NSFW_MAX_FRAMES` | `8` | Кадры, диапазон 1–20 |

Compose задаёт classifier URL/threshold напрямую.

## GitHub Actions

Variable `ENABLE_DEPLOY=true` разрешает deploy после успешного push в `main`/`master`; иначе работает только verify.

Secrets:

- `PROD_ENV_B64` — base64 production `.env`;
- `YOUTUBE_COOKIES_B64` — опциональные cookies;
- `GRAFANA_CLOUD_TOKEN` — stack access-policy token только с `metrics:write` и `logs:write`;
- `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` — deploy SSH;
- `VPS_APP_DIR` — опционально, default `/srv/chat-meme-scraper`;
- `VPS_ROOT_PASSWORD` — только ручные root workflows.

Grafana Cloud repository variables:

- `GRAFANA_CLOUD_PROMETHEUS_URL`;
- `GRAFANA_CLOUD_PROMETHEUS_USER`;
- `GRAFANA_CLOUD_LOKI_URL`;
- `GRAFANA_CLOUD_LOKI_USER`.

Deploy хранит Grafana token на VPS в `private/grafana-cloud-token`; в `.env` и Docker environment он не записывается.

Секреты перенесены server-side; проверять имена, не значения.

```bash
base64 -i .env | tr -d '\n'
```

Workflow пишет cookies атомарно в `/srv/chat-meme-scraper/private/youtube-cookies.txt`; worker видит `/run/private/youtube-cookies.txt`.
