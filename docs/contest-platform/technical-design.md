# Технические границы Contest Platform

Статус: целевая архитектура закрытой беты, без реализации. Product и UX определены в [README.md](README.md).

## 1. Два независимых контура

Существующий архив остаётся Telegram-first:

- `apps/worker` читает Twitch/w.tv, скачивает медиа и публикует в Telegram;
- `apps/bot` обслуживает Telegram admin/public flows;
- приватный Telegram storage-канал остаётся каноническим хранилищем архива.

Contest Platform — новый контур:

- web/API для кабинетов и публичных страниц;
- один фоновый contest worker для обработки файлов, расписания, уведомлений и Twitch-голосования;
- PostgreSQL для бизнес-состояния и очередей;
- существующий Bucket.ru для оригиналов и производных конкурсных файлов;
- Telegram bot и Discord bot только для добровольных уведомлений.

Медиа архива не переносятся в S3, а конкурсные файлы не складываются в Telegram. Контуры могут использовать общие чистые библиотеки, но не общие бизнес-таблицы.

Для закрытой беты не нужны Redis, BullMQ, отдельный ChatGateway и набор микросервисов. DB-очередь с `FOR UPDATE SKIP LOCKED` уже проверена в текущем worker; разделять процессы следует только после измеренного упора в CPU или число подключений.

## 2. Что реально переиспользуется

| Текущий код | Решение |
| --- | --- |
| `packages/core`: URL parsing, нормализация, media type, SSRF/private-IP checks | Переиспользовать для YouTube и любых серверных fetch внешних URL |
| `packages/media-processing`: безопасный запуск ImageMagick/FFmpeg, H.264/AAC, `faststart`, очистка temp-файлов | Переиспользовать основу и тесты; добавить нейтральные web-производные рядом с Telegram-функциями |
| `apps/worker/services/platform-download.ts`: metadata/size/duration checks | Извлекать только чистые функции, когда они понадобятся contest worker |
| `apps/worker/services/downloader.ts` | Не переиспользовать целиком: он связан с archive DB, Telegram limits и archive job lifecycle |
| `DownloadJob` и `FOR UPDATE SKIP LOCKED` | Переиспользовать паттерн, но создать отдельные contest job tables |
| Archive `Asset`, Telegram IDs и storage flow | Не переиспользовать в Contest Platform |
| Twitch chat parsing/dedup by message ID | Переиспользовать поведение; вынести общий код только когда появится второй реальный caller |

Текущий `normalizePhotoForTelegram` и target-size transcode нельзя выдавать за готовый конкурсный pipeline: они оптимизируют под ограничения Telegram. Для конкурса нужны отдельные preview, poster и web MP4, но общие process runners и кодеки уже есть.

## 3. Минимальный runtime закрытой беты

```text
Browser / OBS
      │
      ▼
Contest web + API ───────── PostgreSQL
      │                         ▲
      │ presigned upload        │ jobs/state
      ▼                         │
Bucket.ru S3 ◄──────── Contest worker ───── Twitch chat
                              │
                              ├── Telegram bot
                              └── Discord bot
```

Один web-процесс и один contest worker достаточны до измеренного ограничения. Состояние презентации, vote sessions и бюллетени сохраняются в PostgreSQL; restart процесса не теряет эфир. Live-экраны получают обновления через SSE и после reconnect всегда перечитывают актуальный снимок.

## 4. Bucket.ru и upload flow

Параметры провайдера:

- endpoint: `https://s3.buckets.ru`;
- region: `ru-1`;
- bucket уже создан пользователем;
- домен платформы уже существует.

Bucket.ru рекомендует обычную загрузку до 100 МБ и multipart для больших объектов; незавершённые multipart-части занимают место и должны очищаться. См. [официальную документацию Bucket.ru](https://bucket.ru/docs/objects).

Поток файла:

1. API проверяет роль, этап, текущие лимиты и создаёт `assetId`.
2. Браузер получает короткоживущие presigned URLs и грузит файл напрямую в S3; API не проксирует байты.
3. Для файлов больше 100 МБ используется multipart, рекомендуемый размер части — 64 MiB.
4. После завершения браузер сообщает `assetId`, upload ID, parts/ETags и заявленный размер.
5. Worker проверяет существование, фактический размер, checksum, сигнатуру/MIME, изображение, длительность видео или число страниц PDF.
6. Worker создаёт preview и только необходимую web-версию.
7. Версия заявки становится доступной модерации только после успешной проверки всех файлов.

Ключи объектов генерирует сервер из внутренних ID; пользовательские имена файлов в key не используются. Оригиналы и производные приватны, доступ выдаётся короткими signed URLs. Публичные списки получают только preview.

Незавершённые multipart uploads отменяются через 24 часа. Известные uploads отменяет приложение; такую же lifecycle-очистку следует включить в панели Bucket.ru как страховку. Неотправленные завершённые объекты удаляются через 7 дней после конца приёма.

Глобальная дедупликация оригинальных конкурсных работ по SHA не входит в MVP: совпадения ожидаются редко, а безопасное разделение прав и reference counting усложнят удаление. Вместо этого каждая media job идемпотентна по `assetId + version`, поэтому повторный worker run не создаёт второй набор производных.

## 5. Производные медиа

| Тип | Проверка | Производная |
| --- | --- | --- |
| JPG/PNG/WebP | signature, MIME, dimensions, size | статичный WebP preview; оптимизированная web-копия при необходимости |
| GIF | signature, frames, dimensions, size | статичный WebP для сеток; анимация для полного просмотра |
| MP4/WebM/MOV | signature, MIME, duration, dimensions, size | poster WebP; H.264/AAC MP4 с `faststart`, если оригинал не web-compatible |
| PDF | signature, pages, size | WebP первой страницы; постраничный viewer |
| YouTube | canonical URL, доступность, duration | thumbnail; видео в S3 не копируется |

Оригинал никогда не изменяется. Производная создаётся один раз и переиспользуется в презентации и архиве. Видео и PDF не предзагружаются в списках.

Для FFmpeg/ImageMagick сохраняются текущие гарантии: аргументы передаются без shell, есть timeout, временные файлы удаляются и повтор задания безопасен. PDF renderer — единственная полностью новая media-зависимость; выбирать её следует во время реализации по поддержке sandbox и первой страницы, а не заранее.

## 6. Идентичность и сессии

Минимальная модель:

- `User` — внутренний владелец всех продуктовых данных;
- `ExternalIdentity` — provider, стабильный subject ID, display snapshot и состояние подключения;
- уникальность `(provider, subjectId)` глобально;
- уникальность `(userId, provider)` ограничивает пользователя одной идентичностью каждого типа;
- `NotificationContact` хранит отдельное согласие и результат test message;
- `UserProfile` хранит изменяемые display name и avatar asset.

Используются server-side OAuth code flows там, где они доступны, и минимальные scopes; подписанные данные Telegram проверяются на сервере:

- [Twitch OAuth/OIDC](https://dev.twitch.tv/docs/authentication/) для identity; дополнительные Twitch-права запрашиваются только организатору при необходимости;
- [Discord OAuth2](https://docs.discord.com/developers/topics/oauth2) с `identify`; bot DM включается отдельным пользовательским действием;
- [Telegram Login Widget](https://core.telegram.org/widgets/login/) с привязанным доменом; доступ бота к сообщениям запрашивается отдельно.

Link, replace и merge требуют свежего подтверждения провайдера и выполняются транзакционно. Collision никогда не раскрывает данные второго пользователя до подтверждения. Access/refresh tokens не попадают в логи; сохраняются только когда нужны для интеграции, в защищённом виде.

## 7. Twitch-голосование

Contest worker читает чат только для Twitch-каналов с активной vote session. Он не отправляет сообщения. Каждое входное сообщение дедуплицируется по Twitch message ID, а последняя валидная команда пользователя заменяет его бюллетень в транзакции.

Отдельный ChatGateway не нужен, пока архив и конкурс могут независимо читать нужные каналы без операционного ограничения. Если это станет проблемой, общий адаптер извлекается из реального кода; Redis не вводится заранее.

Потеря соединения меняет session на technical pause и останавливает server-side timer. После reconnect оператор продолжает вручную. Candidate snapshot и author Twitch IDs сохраняются вместе с vote session, поэтому подсчёт не зависит от изменяемой заявки.

## 8. Презентация и публичная доставка

- OBS URL содержит отдельный длинный rotatable token и даёт только read-only доступ к конкретному конкурсу.
- Управляющая сессия использует обычные права пользователя, а не OBS token.
- Один server-side operator lock исключает двойное управление; organizer может перехватить его.
- SSE сообщает об изменениях, но не является источником истины: после reconnect клиент читает полный state.
- До финализации media URLs доступны только участнику и ролям конкурса.
- После финализации публичны оптимизированные производные; оригиналы остаются закрытыми.
- Для снижения исходящего трафика применяются browser/CDN cache headers для immutable производных и lazy loading.

## 9. Удаление и восстановление

Удаление всегда идёт через бизнес-состояние, а не прямой prefix wipe:

- отменённый конкурс хранит объекты 7 дней, затем job удаляет originals и derivatives;
- авторская очистка финализированной работы удаляет media/description, но сохраняет result snapshot;
- admin content removal удаляет запрещённые media и оставляет moderation record;
- удаление пользователя очищает незавершённые assets и обезличивает опубликованную историю;
- каждый delete job идемпотентен и может безопасно повторяться.

## 10. Проверки перед закрытой бетой

Обязательные automated checks:

- три login flows, link, replace, collision и merge;
- запрет потери последнего способа входа;
- upload resume, дедлайн, 60-минутный grace и очистка multipart;
- MIME/signature mismatch, повреждённый файл и граничные лимиты;
- idempotent media processing и delete jobs;
- atomic moderation version switch;
- immutable vote candidates, replacement ballot, Borda ties и reconnect pause;
- finalization snapshot, admin revision, cancellation restore/purge;
- regression tests существующего Telegram archive pipeline.

Отдельный smoke-сценарий прогоняет 20 смешанных заявок и около 200 голосующих без ручного доступа разработчика к БД/S3. Проверка на 2 000 SSE viewers — отдельный load gate.

## 11. Отложено до измеренной необходимости

- Redis и отдельный event bus;
- ChatGateway как отдельный deployable service;
- несколько media workers и распределённые locks вне PostgreSQL;
- CDN-провайдер поверх Bucket.ru;
- глобальная дедупликация пользовательских оригиналов;
- антивирус и автоматическая модерация контента;
- отдельный search engine;
- многоязычность.
