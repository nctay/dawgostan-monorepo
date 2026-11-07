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

## Приватный бот-конвертер

`TELEGRAM_CONVERTER_BOT_TOKEN` включает отдельного бота в существующем bot-процессе. Без токена конвертер выключен, архив работает как прежде. `TELEGRAM_CONVERTER_ALLOWED_USERNAMES` — разрешённые @username через запятую, без учёта регистра и начального `@`.

Создай отдельного бота в BotFather и добавь его администратором в `TELEGRAM_STORAGE_CHAT_ID` с правом публиковать сообщения. Настройки конвертера передаются через отдельный секрет `TELEGRAM_CONVERTER_ENV_B64`. Деплой декодирует его и добавляет строки в `.env` для обоих сервисов. Токен конвертера должен отличаться от токенов ботов архива.

При первом `/start` разрешённое имя однократно связывается с Telegram ID. Смена @username сохраняет доступ; исключение исходного имени из настройки отзывает его после перезапуска сервисов. Передача старого имени другому аккаунту не передаёт уже привязанный доступ.

Личная видеоссылка создаёт отдельный conversion request, без ChatPost, StreamSession и публичного Asset. Обработка использует общие слоты `MAX_PARALLEL_DOWNLOADS`, существующий загрузчик и приватный Telegram storage. Длительность — до 5 минут (или меньшего `MAX_PLATFORM_VIDEO_SECONDS`), готовый файл — до 49 900 000 байт. Картинки, анимации и альбомы не выдаются конвертером. Личные видео не публикуются в канале архива.

Конвертер запускает yt-dlp без аккаунтных cookies архива и без пользовательской конфигурации: доступны только публичные источники. Повторно скачанные одинаковые bytes переиспользуют file_id конвертера без второго поста в storage; идентификаторы другого бота не используются.

Перезапуск возобновляет прерванные скачивания. Состояния отправки с неизвестным результатом не повторяются автоматически: владелец получает уведомление и проверяет сообщения. Миграция `000011_converter` добавляет только таблицы и enum, существующие данные не меняет.

Проверка после настройки: оба пользователя открывают нового бота и нажимают `/start`, каждый отправляет одну публичную ссылку. Готовое видео должно прийти только отправителю; попытка третьего аккаунта и попытка вне личного чата не создают запрос. Подключение каналов и публикация добавляются следующими тикетами.

`TELEGRAM_CONVERTER_TEST_CHANNEL_ID` включает автозамену для одного тестового канала с числовым ID `-100…`. Дай боту право редактировать посты. Для перепоста нужны также права публикации и удаления. Опубликуй текст с одной ссылкой на поддерживаемое видео, фото или GIF. Бот заменит её в подписи на кликабельную «Ссылка» и попробует отредактировать тот же пост. Альбомы и подписи длиннее 1024 символов пропускаются. Если редактирование явно запрещено, бот публикует медиа и удаляет оригинал после подтверждения публикации. При сетевой ошибке результат сохраняется как неопределённый для ручной проверки.

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
- `TELEGRAM_CONVERTER_ENV_B64` — опциональные настройки конвертера в base64;
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
