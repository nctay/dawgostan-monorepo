# Project Memory

Be brief.

## What This Project Is

This is a Telegram-first Twitch chat media archive.

The production v1 stack is:
- PostgreSQL
- worker
- Telegram admin/public bots
- private Telegram storage channel
- optional public Telegram channel

Old web/S3/MinIO/admin UI paths are not strategic for v1. Prefer Telegram bot/channel flows.

## User Intent

The user usually wants practical, production-oriented help:
- keep the service running on VPS
- recover missed stream/chat media
- improve Twitch media ingestion
- improve Telegram presentation
- avoid losing PostgreSQL data
- ship small safe fixes quickly

Prefer direct commands, concise explanations, and clear "run this next" steps.

## Production Shape

Prod runs with `docker-compose.prod.yml` under:

```bash
/srv/chat-meme-scraper
```

Common prod commands:

```bash
cd /srv/chat-meme-scraper
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f worker bot
docker compose -f docker-compose.prod.yml logs --tail=200 worker bot
docker compose -f docker-compose.prod.yml run --rm worker pnpm db:migrate
```

Do not suggest deleting Docker volumes or recreating Postgres unless the user explicitly accepts data loss.

## Important Product Rules

- Telegram storage channel is the canonical media storage for v1.
- Public Telegram channel should receive the same stored media except private/test streamers.
- `TELEGRAM_PRIVATE_STREAMER_LOGINS` controls streamers hidden from public bot/channel.
- Test streamer `nctay` is intended to stay private unless user says otherwise.
- Public channel captions use hashtags like:

```text
#streamer_stream #date_YYYY_MM_DD #user_sender
```

If there is text besides the URL, append:

```text
: message text without URLs
```

No trailing colon when there is no message text.

## Ingestion Rules

- Do not parse/save media while streamer is offline.
- Keep a 30 minute grace period after stream ends.
- If streamer reconnects within the grace period, treat it as the same stream.
- Ignore chat command posts where message starts with `!sr`.
- Ignore bot authors `Nightbot` and `StreamElements`.
- Deduplicate repeated media at least within one stream.
- Do not post duplicate media to storage/public channel when already stored.

## Downloader Notes

- Direct images/videos and platform links are supported.
- TikTok / YouTube Shorts use `yt-dlp` and `ffmpeg`.
- Platform video duration target is currently up to 5 minutes.
- Avoid downloading huge platform files when metadata proves they exceed limits.
- GIF links must stay GIF/animation, not still images.
- Videos should be Telegram-compatible and include width/height/duration when sent.

## Recovery Notes

There is a one-off VOD chat recovery script:

```bash
node apps/worker/dist/scripts/recover-vod-chat.js
```

Required env:

```bash
RECOVERY_VOD_ID
RECOVERY_FROM
RECOVERY_TO
```

Default is dry-run. Real run:

```bash
RECOVERY_DRY_RUN=false
```

Example:

```bash
docker compose -f docker-compose.prod.yml run --rm \
  -e RECOVERY_VOD_ID=2792466641 \
  -e RECOVERY_FROM='2026-06-09T18:57:00+03:00' \
  -e RECOVERY_TO='2026-06-09T19:56:00+03:00' \
  -e RECOVERY_DRY_RUN=false \
  worker node apps/worker/dist/scripts/recover-vod-chat.js
```

The script creates `ChatPost`, `Asset`, and `DownloadJob`; the normal worker downloads and posts.

## CI/CD Notes

Deployment is GitHub Actions based. Push to `main` builds/pushes worker and bot images and deploys by SSH.

Secrets are managed in GitHub Actions. Do not print tokens.

If SSH deploy fails:
- first check `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`
- verify the `deploy` user can run Docker
- verify `/srv/chat-meme-scraper` exists and is writable by `deploy`

## Local Checks

Useful checks before pushing:

```bash
pnpm test
pnpm --filter worker typecheck
pnpm --filter worker build
```

If worker tests fail resolving a workspace package, build dependencies first:

```bash
pnpm turbo run build --filter=worker...
```
