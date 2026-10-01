# Документация Dawgostan

Актуально на 2026-10-01. Источник истины: код, Prisma schema, Compose и GitHub Actions.

- [Архитектура](architecture.md) — сервисы, пакеты, БД.
- [Media pipeline](media-pipeline.md) — путь от чата до Telegram.
- [Конфигурация](configuration.md) — env и GitHub secrets.
- [Эксплуатация](operations.md) — запуск, deploy, VPS, backup, recovery.

## Production v1

Контур: PostgreSQL, `worker`, Telegram admin/public bots, приватный storage-канал, опциональные public/deleted каналы, `nsfw-ensemble`. Telegram storage — каноническое хранилище; PostgreSQL хранит метаданные и Telegram IDs.

Правила:

- Не сохранять медиа offline.
- После offline держать grace period 30 минут; reconnect продолжает сессию.
- Игнорировать `!sr`, `catAsk`, `Nightbot`, `StreamElements`.
- Не отправлять повторно сохранённое медиа.
- `TELEGRAM_PRIVATE_STREAMER_LOGINS` скрывает стримеров из public surfaces; `nctay` остаётся приватным без явного решения.
- Не удалять PostgreSQL volume и не пересоздавать БД ради troubleshooting.
- Не печатать и не коммитить токены, cookies, `.env`, GitHub secrets.

Удалены web/API/S3 runtime, старые NSFW/FalconsAI эксперименты, benchmarks и chat dump. Исторические S3-поля сохранены в schema/migrations против потери старых данных.
