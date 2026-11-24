import { setTimeout as delay } from "node:timers/promises";
import { Bot, BotError, Composer, GrammyError, HttpError, InlineKeyboard } from "grammy";
import { sequentialize } from "@grammyjs/runner";
import type { Context } from "grammy";
import { stripSkipTelegramPublicTag } from "@dawgostan/core";
import type { Prisma } from "@prisma/client";
import { allowedUserIds, env, privateStreamerLogins } from "./env.js";
import { prisma } from "./prisma.js";
import { canRetryTelegramSend, ChatRateLimiter, publicTelegramFetch, telegramCall, telegramSignal } from "./rate-limit.js";
import { logBotAlert } from "./alert-log.js";
import { createConverterBot } from "./converter.js";
import { createPublicPolling } from "./public-polling.js";
import { isTransientDatabaseError, retryInbox } from "./database-errors.js";
import { ackOnly, mediaPage } from "./public-page.js";
import { publicInbox, PublicInboxError } from "./public-inbox.js";

const pageSize = 10;
const publicPageSize = 50;
const lifecycle = new AbortController();
const bots: Pick<Bot, "start" | "stop">[] = [];

const adminBot = new Bot(env.TELEGRAM_BOT_TOKEN);
bots.push(adminBot);

adminBot.use(async (ctx, next) => {
  if (ctx.chat?.type === "channel") return;
  const userId = ctx.from?.id;
  if (!userId || !allowedUserIds.has(userId)) {
    await ctx.reply("Доступ закрыт.");
    return;
  }
  await next();
});

adminBot.command("start", async (ctx) => {
  await ctx.reply("Архив Twitch media.", {
    reply_markup: new InlineKeyboard()
      .text("Последние 10", "latest:all:0")
      .text("Картинки", "latest:image:0")
      .row()
      .text("Видео", "latest:video:0")
      .text("Стримы", "streams:0"),
  });
});

adminBot.command("live", async (ctx) => {
  const sessions = await prisma.streamSession.findMany({
    where: { status: "live" },
    orderBy: { startedAt: "desc" },
    include: { streamer: true, _count: { select: { posts: true } } },
  });

  if (sessions.length === 0) {
    await ctx.reply("Сейчас live-стримов нет.");
    return;
  }

  await ctx.reply(formatSessions(sessions), { reply_markup: sessionsKeyboard(sessions) });
});

adminBot.command("streams", async (ctx) => {
  await sendStreams(ctx, 0);
});

adminBot.command("latest", async (ctx) => {
  await sendLatest(ctx, "all", 0);
});

adminBot.command("stream", async (ctx) => {
  const streamId = ctx.match.trim();
  if (!streamId) {
    await ctx.reply("Формат: /stream <stream_id>");
    return;
  }
  await sendStream(ctx, streamId, "all", 0);
});

adminBot.callbackQuery(/^latest:(all|image|video):(\d+)$/, async (ctx) => {
  await answerCallbackQuerySafely(ctx);
  const [, type, offset] = ctx.match;
  await sendLatest(ctx, type as MediaFilter, Number(offset));
});

adminBot.callbackQuery(/^streams:(\d+)$/, async (ctx) => {
  await answerCallbackQuerySafely(ctx);
  await sendStreams(ctx, Number(ctx.match[1]));
});

adminBot.callbackQuery(/^openstream:(.+)$/, async (ctx) => {
  await answerCallbackQuerySafely(ctx);
  await sendStream(ctx, ctx.match[1]!, "all", 0);
});

adminBot.callbackQuery(/^stream:(.+):(all|image|video):(\d+)$/, async (ctx) => {
  await answerCallbackQuerySafely(ctx);
  const [, streamId, type, offset] = ctx.match;
  await sendStream(ctx, streamId!, type as MediaFilter, Number(offset));
});

adminBot.callbackQuery(/^hide:(.+)$/, async (ctx) => {
  const asset = await prisma.asset.update({
    where: { id: ctx.match[1] },
    data: { visibility: "hidden" },
  });
  await answerCallbackQuerySafely(ctx, { text: "Скрыто" });
  await ctx.reply(`Скрыто: ${asset.normalizedUrl}`);
});

adminBot.callbackQuery(/^del:(.+)$/, async (ctx) => {
  const asset = await prisma.asset.findUniqueOrThrow({ where: { id: ctx.match[1] } });
  if (asset.telegramChatId && asset.telegramMessageId) {
    const messageIds = asset.telegramMessageIds.length > 1 ? asset.telegramMessageIds : [asset.telegramMessageId];
    const deleted = messageIds.length > 1 ? adminBot.api.deleteMessages(asset.telegramChatId, messageIds) : adminBot.api.deleteMessage(asset.telegramChatId, messageIds[0]!);
    await deleted.catch((error) => {
      logBotAlert({
        scope: "moderation",
        code: "telegram_delete_failed",
        title: "Не удалось удалить медиа из Telegram",
        severity: "action",
        error,
        details: { asset_id: asset.id },
      });
    });
  }

  await prisma.$transaction(async (tx) => {
    await tx.asset.update({
      where: { id: asset.id },
      data: {
        status: "deleted",
        visibility: "hidden",
        deletedAt: new Date(),
        deletedBy: String(ctx.from?.id ?? "telegram"),
        deleteReason: "telegram moderation",
        publicUrl: null,
      },
    });

    await tx.blockedMedia.upsert({
      where: { normalizedUrl: asset.normalizedUrl },
      create: {
        normalizedUrl: asset.normalizedUrl,
        sha256: asset.sha256,
        reason: "telegram moderation",
        sourceAssetId: asset.id,
      },
      update: {
        sha256: asset.sha256,
        reason: "telegram moderation",
        sourceAssetId: asset.id,
      },
    });

    for (const sha256 of new Set(asset.sha256s.filter((hash) => hash !== asset.sha256))) {
      await tx.blockedMedia.upsert({
        where: { sha256 },
        create: {
          sha256,
          reason: "telegram moderation",
          sourceAssetId: asset.id,
        },
        update: {
          reason: "telegram moderation",
          sourceAssetId: asset.id,
        },
      });
    }
  });

  await answerCallbackQuerySafely(ctx, { text: "Удалено и заблокировано" });
  await ctx.reply(`Удалено: ${asset.normalizedUrl}`);
});

adminBot.catch((error) => logBotError("admin-bot", error));

const publicPageLimiter = new ChatRateLimiter(1100, lifecycle.signal);
const publicBot = env.TELEGRAM_PUBLIC_BOT_TOKEN
  ? new Bot(env.TELEGRAM_PUBLIC_BOT_TOKEN, { client: { fetch: publicTelegramFetch } })
  : null;
if (publicBot) {
  // Duplicate callbacks can be acknowledged while the owner is still sending.
  publicBot.use((ctx, next) => ackOnly in ctx.update ? handlePublicUpdate(ctx, true) : next());
  publicBot.use(sequentialize((ctx) => ctx.chat?.id.toString()));

  const routes = new Composer<Context>();
  routes.command("start", async (ctx) => {
    await sendPublicStreamers(ctx, 0);
  });

  routes.command("streamers", async (ctx) => {
    await sendPublicStreamers(ctx, 0);
  });

  routes.callbackQuery(/^pub:streamers:(\d+)$/, async (ctx) => {
    await answerCallbackQuerySafely(ctx);
    await sendPublicStreamers(ctx, Number(ctx.match[1]));
  });

  routes.callbackQuery(/^pub:streamer:([^:]+):(\d+)$/, async (ctx) => {
    await answerCallbackQuerySafely(ctx);
    await sendPublicStreams(ctx, ctx.match[1]!, Number(ctx.match[2]));
  });

  const dispatch = routes.middleware();
  let receiptFailure: PublicInboxError | undefined;
  publicBot.use(ctx => handlePublicUpdate(ctx, false));

  async function handlePublicUpdate(ctx: Context, duplicatePage: boolean) {
    if (receiptFailure) throw receiptFailure;
    try {
      const page = mediaPage.exec(ctx.callbackQuery?.data ?? "");
      let pageAcknowledged = false;
      let pageConsumed = false;
      for (let wait = 100; ; wait = Math.min(wait * 2, 30_000)) {
        try {
          if (page && !pageAcknowledged) {
            await answerCallbackQuerySafely(ctx);
            pageAcknowledged = true;
          }
          if (page) {
            if (!duplicatePage) {
              await sendPublicMessages(ctx, page[2]!, Number(page[3]), async () => {
                const claimed = await publicInbox(ctx.me.id).claimPage(ctx.update.update_id, lifecycle.signal);
                pageConsumed = true;
                return claimed;
              }, page[1] === "after");
            }
          } else {
            await dispatch(ctx, async () => {});
          }
          break;
        } catch (error) {
          if (error instanceof PublicInboxError) throw error;
          const dbUnavailable = isTransientDatabaseError(error);
          // Only claiming a media page commits us to at-most-once delivery.
          const retryTelegram = canRetryTelegramSend(error) || (page && !pageAcknowledged && error instanceof HttpError);
          if (pageConsumed || (!dbUnavailable && !retryTelegram)) {
            logBotError("public-bot", new BotError(error, ctx));
            break;
          }
          const retryAfter = error instanceof GrammyError ? error.parameters.retry_after : undefined;
          logBotAlert({ scope: "public-bot", error: new Error(dbUnavailable ? "Database temporarily unavailable" : "Telegram temporarily unavailable") });
          try {
            await delay(retryAfter ? retryAfter * 1000 : wait, undefined, { signal: lifecycle.signal });
          } catch {
            throw new PublicInboxError("Public bot stopped during retry");
          }
        }
      }
      await publicInbox(ctx.me.id).finish(ctx.update.update_id, lifecycle.signal);
    } catch (error) {
      if (error instanceof PublicInboxError) {
        receiptFailure = error;
        lifecycle.abort();
      }
      throw error;
    }
  }

  publicBot.catch((error) => logBotError("public-bot", error));
  bots.push(createPublicPolling(publicBot));
}

const converterBot = createConverterBot();
if (converterBot) {
  converterBot.catch((error) => logBotError("converter-bot", error));
  bots.push(converterBot);
}

let stopping = false;
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

try {
  const signal = telegramSignal(lifecycle.signal);
  await telegramCall("setMyCommands", () => adminBot.api.setMyCommands([
    { command: "start", description: "Меню" },
    { command: "live", description: "Live-стримы" },
    { command: "streams", description: "Последние стримы" },
    { command: "latest", description: "Последние 10 медиа" },
    { command: "stream", description: "Медиа стрима по id" },
  ], {}, signal), lifecycle.signal);
  if (publicBot) {
    await telegramCall("setMyCommands", () => publicBot.api.setMyCommands([
      { command: "start", description: "Выбрать стримера" },
      { command: "streamers", description: "Список стримеров" },
    ], {}, signal), lifecycle.signal);
  }
} catch (error) {
  if (!stopping) throw error;
}

console.log(`[bot] starting admin${publicBot ? " and public" : ""}${converterBot ? " and converter" : ""}`);
try {
  if (!stopping) await Promise.all(bots.map((runningBot) => runningBot.start()));
} catch (error) {
  if (!stopping) {
    logBotError("polling", error);
    process.exitCode = 1;
    shutdown();
  }
} finally {
  await prisma.$disconnect();
}

type MediaFilter = "all" | "image" | "video";
type PostWithMedia = Prisma.ChatPostGetPayload<{
  include: { asset: true; streamSession: { include: { streamer: true } } };
}>;
type PublicPostWithAsset = Prisma.ChatPostGetPayload<{ include: { asset: true } }>;

type CallbackQueryOptions = Parameters<Context["answerCallbackQuery"]>[0];

async function answerCallbackQuerySafely(ctx: Context, options?: CallbackQueryOptions): Promise<void> {
  try {
    await ctx.answerCallbackQuery(options);
  } catch (error) {
    if (isExpiredCallbackQueryError(error)) {
      console.warn("[bot] ignored expired callback query", { callbackData: ctx.callbackQuery?.data });
      return;
    }
    throw error;
  }
}

function logBotError(scope: string, error: unknown): void {
  const botError = error instanceof BotError ? error : undefined;
  logBotAlert({
    scope,
    error: botError?.error ?? error,
    details: {
      update_id: botError?.ctx.update.update_id,
      handler: botError?.name,
    },
  });
}

function isExpiredCallbackQueryError(error: unknown): boolean {
  return (
    error instanceof GrammyError &&
    error.method === "answerCallbackQuery" &&
    error.error_code === 400 &&
    error.description.includes("query is too old")
  );
}

async function sendLatest(ctx: Context, type: MediaFilter, offset: number): Promise<void> {
  const posts = await prisma.chatPost.findMany({
    where: {
      status: "stored",
      asset: {
        status: "stored",
        visibility: "public",
        ...(type === "all" ? {} : { mediaType: type }),
      },
    },
    orderBy: { postedAt: "desc" },
    skip: offset,
    take: pageSize,
    include: { asset: true, streamSession: { include: { streamer: true } } },
  });

  await ctx.reply(titleForFilter(type), { reply_markup: latestKeyboard(type, offset + pageSize) });
  await sendPosts(ctx, uniquePostsByStreamAsset(posts));
}

async function sendStream(ctx: Context, streamId: string, type: MediaFilter, offset: number): Promise<void> {
  const session = await prisma.streamSession.findUnique({
    where: { id: streamId },
    include: { streamer: true },
  });
  if (!session) {
    await ctx.reply("Стрим не найден.");
    return;
  }

  const posts = await prisma.chatPost.findMany({
    where: {
      streamSessionId: streamId,
      status: "stored",
      asset: {
        status: "stored",
        visibility: "public",
        ...(type === "all" ? {} : { mediaType: type }),
      },
    },
    orderBy: { postedAt: "desc" },
    distinct: ["assetId"],
    skip: offset,
    take: pageSize,
    include: { asset: true, streamSession: { include: { streamer: true } } },
  });

  await ctx.reply(`${session.streamer.displayName} / ${formatDate(session.startedAt)}\n${session.title ?? "Без названия"}`, {
    reply_markup: streamKeyboard(streamId, type, offset + pageSize),
  });
  await sendPosts(ctx, uniquePostsByAsset(posts));
}

async function sendStreams(ctx: Context, offset: number): Promise<void> {
  const sessions = await prisma.streamSession.findMany({
    orderBy: { startedAt: "desc" },
    skip: offset,
    take: pageSize,
    include: { streamer: true, _count: { select: { posts: true } } },
  });

  if (sessions.length === 0) {
    await ctx.reply("Стримов пока нет.");
    return;
  }

  await ctx.reply(formatSessions(sessions), {
    reply_markup: sessionsKeyboard(sessions).row().text("Следующие", `streams:${offset + pageSize}`),
  });
}

async function sendPublicStreamers(ctx: Context, offset: number): Promise<void> {
  const streamers = await prisma.streamer.findMany({
    where: {
      enabled: true,
      ...publicStreamerAccessWhere(ctx),
      sessions: {
        some: {
          posts: {
            some: publicStoredPostWhere(),
          },
        },
      },
    },
    orderBy: { displayName: "asc" },
    skip: offset,
    take: pageSize,
  });

  if (streamers.length === 0) {
    await ctx.reply("Публичных стримеров пока нет.");
    return;
  }

  const keyboard = new InlineKeyboard();
  for (const streamer of streamers) {
    keyboard.text(streamer.displayName, `pub:streamer:${streamer.id}:0`).row();
  }
  keyboard.text("Показать еще", `pub:streamers:${offset + pageSize}`);

  await ctx.reply("Выбери стримера:", { reply_markup: keyboard });
}

async function sendPublicStreams(ctx: Context, streamerId: string, offset: number): Promise<void> {
  const streamer = await prisma.streamer.findUnique({ where: { id: streamerId } });
  if (!streamer) {
    await ctx.reply("Стример не найден.");
    return;
  }
  if (!canAccessPublicStreamer(ctx, streamer.login)) {
    await ctx.reply("Стример не найден.");
    return;
  }

  const sessions = await prisma.streamSession.findMany({
    where: {
      streamerId,
      posts: {
        some: publicStoredPostWhere(),
      },
    },
    orderBy: { startedAt: "desc" },
    skip: offset,
    take: pageSize,
    include: {
      _count: {
        select: {
          posts: { where: publicStoredPostWhere() },
        },
      },
    },
  });

  if (sessions.length === 0) {
    await ctx.reply("У этого стримера пока нет публичных сохраненных стримов.");
    return;
  }

  const keyboard = new InlineKeyboard();
  for (const session of sessions) {
    const count = session._count.posts;
    keyboard.text(`${formatDate(session.startedAt)} (${count})`, `pub:stream:${session.id}:0`).row();
  }
  keyboard.text("Назад к стримерам", "pub:streamers:0").row().text("Показать еще", `pub:streamer:${streamerId}:${offset + pageSize}`);

  await ctx.reply(`Стримы: ${streamer.displayName}`, { reply_markup: keyboard });
}

async function sendPublicMessages(ctx: Context, streamId: string, offset: number, claimPage: () => Promise<boolean>, after = false): Promise<void> {
  const send = <T>(task: () => Promise<T>) => publicPageLimiter.schedule(ctx.chat!.id, task);
  const cursor = after ? await prisma.chatPost.findUnique({
    where: { id: streamId }, select: { id: true, streamSessionId: true, postedAt: true },
  }) : null;
  if (after && !cursor) {
    await send(() => ctx.reply("Стрим не найден."));
    return;
  }
  if (cursor) streamId = cursor.streamSessionId;
  const session = await prisma.streamSession.findUnique({
    where: { id: streamId },
    include: { streamer: true },
  });
  if (!session || !canAccessPublicStreamer(ctx, session.streamer.login)) {
    await send(() => ctx.reply("Стрим не найден."));
    return;
  }

  const posts = await prisma.chatPost.findMany({
    where: {
      streamSessionId: streamId,
      asset: {
        ...publicStoredPostWhere().asset,
        posts: {
          some: { streamSessionId: streamId, ...publicStoredPostWhere() },
          // Position each asset by its newest reference, independent of privacy edits.
          ...(cursor ? { none: {
            streamSessionId: streamId,
            OR: [{ postedAt: { gt: cursor.postedAt } }, { postedAt: cursor.postedAt, id: { gte: cursor.id } }],
          } } : {}),
        },
      },
      ...(cursor ? {
        OR: [{ postedAt: { lt: cursor.postedAt } }, { postedAt: cursor.postedAt, id: { lt: cursor.id } }],
      } : {}),
    },
    orderBy: [{ postedAt: "desc" }, { id: "desc" }],
    distinct: ["assetId"],
    skip: cursor ? 0 : offset,
    take: publicPageSize,
    select: { id: true, assetId: true },
  });

  if (posts.length === 0) {
    await send(() => ctx.reply("Сообщений больше нет."));
    return;
  }

  // Telegram cannot replay a partially sent page idempotently. Only consume it
  // once it reaches the front of its chat, immediately before the first send.
  await publicPageLimiter.waitForTurn(ctx.chat!.id);
  if (!(await claimPage())) return;
  await send(() => ctx.reply(`${session.streamer.displayName} / ${formatDate(session.startedAt)}`));

  let copied = 0;
  for (const { assetId } of posts) {
    // Moderation and VOD recovery can change a selected post while its slot or retry is waiting.
    const visiblePost = () => retryInbox(() => prisma.chatPost.findFirst({
      where: { assetId, streamSessionId: streamId, ...publicStoredPostWhere() },
      orderBy: [{ postedAt: "desc" }, { id: "desc" }],
      include: { asset: true },
    }), lifecycle.signal);
    const delivery = await send(async () => {
      const post = await visiblePost();
      const asset = post?.asset;
      if (!post || !asset?.telegramChatId || !asset.telegramMessageId) return null;
      if (asset.telegramMessageIds.length > 1) {
        const album = await ctx.api.copyMessages(ctx.chat!.id, asset.telegramChatId, asset.telegramMessageIds, { remove_caption: true });
        return album[0] ? { captionMessageId: album[0].message_id } : null;
      }
      await ctx.api.copyMessage(ctx.chat!.id, asset.telegramChatId, asset.telegramMessageId, { caption: publicMediaCaption(post) });
      return { captionMessageId: null };
    });
    if (!delivery) continue;
    const { captionMessageId } = delivery;
    if (captionMessageId !== null) {
      await send(async () => {
        const post = await visiblePost();
        if (post) await ctx.api.editMessageCaption(ctx.chat!.id, captionMessageId, { caption: publicMediaCaption(post) });
      });
    }
    copied += 1;
  }

  if (copied === 0) {
    await send(() => ctx.reply("В этой пачке нет доступных Telegram-медиа."));
  }

  const keyboard = new InlineKeyboard()
    .text("Назад к датам", `pub:streamer:${session.streamerId}:0`)
    .row()
    .text("Показать еще", `pub:after:${posts.at(-1)!.id}:${offset + copied}`);
  await send(() => ctx.reply(`Показано: ${offset + copied}`, { reply_markup: keyboard }));
}

async function sendPosts(ctx: Context, posts: PostWithMedia[]): Promise<void> {
  if (posts.length === 0) {
    await ctx.reply("Медиа не найдено.");
    return;
  }

  for (const post of posts) {
    const asset = post.asset;
    if (!asset?.telegramChatId || !asset.telegramMessageId) {
      await ctx.reply(`${post.normalizedUrl}\nНет Telegram-сообщения в storage.`);
      continue;
    }

    const controls = new InlineKeyboard().text("Скрыть", `hide:${asset.id}`).text("Удалить", `del:${asset.id}`);
    if (asset.telegramMessageIds.length > 1) {
      const copied = await ctx.api.copyMessages(ctx.chat!.id, asset.telegramChatId, asset.telegramMessageIds, { remove_caption: true });
      if (copied[0]) await ctx.api.editMessageCaption(ctx.chat!.id, copied[0].message_id, { caption: mediaCaption(post) });
      await ctx.reply("Управление альбомом", { reply_markup: controls });
    } else {
      await ctx.api.copyMessage(ctx.chat!.id, asset.telegramChatId, asset.telegramMessageId, {
        caption: mediaCaption(post),
        reply_markup: controls,
      });
    }
  }
}

function latestKeyboard(type: MediaFilter, nextOffset: number): InlineKeyboard {
  return baseFilterKeyboard("latest", type).row().text("Следующие", `latest:${type}:${nextOffset}`);
}

function streamKeyboard(streamId: string, type: MediaFilter, nextOffset: number): InlineKeyboard {
  return baseFilterKeyboard(`stream:${streamId}`, type).row().text("Следующие", `stream:${streamId}:${type}:${nextOffset}`);
}

function baseFilterKeyboard(prefix: string, type: MediaFilter): InlineKeyboard {
  const callback = (nextType: MediaFilter) => `${prefix}:${nextType}:0`;
  return new InlineKeyboard()
    .text(type === "all" ? "Последние 10 *" : "Последние 10", callback("all"))
    .text(type === "image" ? "Картинки *" : "Картинки", callback("image"))
    .row()
    .text(type === "video" ? "Видео *" : "Видео", callback("video"));
}

function sessionsKeyboard(sessions: Array<{ id: string; streamer: { displayName: string }; startedAt: Date }>): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const session of sessions) {
    keyboard.text(`${session.streamer.displayName} ${formatDate(session.startedAt)}`, `openstream:${session.id}`).row();
  }
  return keyboard;
}

function formatSessions(sessions: Array<{ id: string; title: string | null; status: string; startedAt: Date; streamer: { displayName: string }; _count: { posts: number } }>): string {
  return sessions
    .map((session) => [`${session.streamer.displayName} (${session.status})`, formatDate(session.startedAt), session.title ?? "Без названия", `id: ${session.id}`, `posts: ${session._count.posts}`].join("\n"))
    .join("\n\n");
}

function mediaCaption(post: PostWithMedia): string {
  return [`${post.streamSession.streamer.displayName} / ${formatDate(post.postedAt)}`, post.authorName, post.normalizedUrl].join("\n");
}

function publicStoredPostWhere() {
  return {
    status: "stored" as const,
    skipTelegramPublic: false,
    asset: {
      status: "stored" as const,
      visibility: "public" as const,
    },
  };
}

function uniquePostsByAsset<T extends { assetId: string | null; asset?: { id: string } | null }>(posts: T[]): T[] {
  const seen = new Set<string>();
  return posts.filter((post) => {
    const assetId = post.assetId ?? post.asset?.id;
    if (!assetId) return true;
    if (seen.has(assetId)) return false;
    seen.add(assetId);
    return true;
  });
}

function uniquePostsByStreamAsset<T extends { streamSessionId: string; assetId: string | null; asset?: { id: string } | null }>(posts: T[]): T[] {
  const seen = new Set<string>();
  return posts.filter((post) => {
    const assetId = post.assetId ?? post.asset?.id;
    if (!assetId) return true;
    const key = `${post.streamSessionId}:${assetId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function publicStreamerAccessWhere(ctx: Context) {
  if (isAllowedAdmin(ctx)) return {};
  return { login: { notIn: [...privateStreamerLogins] } };
}

function canAccessPublicStreamer(ctx: Context, login: string): boolean {
  return isAllowedAdmin(ctx) || !privateStreamerLogins.has(login.toLowerCase());
}

function isAllowedAdmin(ctx: Context): boolean {
  const userId = ctx.from?.id;
  return Boolean(userId && allowedUserIds.has(userId));
}

function publicMediaCaption(post: PublicPostWithAsset): string {
  const text = stripSkipTelegramPublicTag(stripUrls(post.messageText));
  const prefix = `[${formatMoscowTime(post.postedAt)}] [${post.authorName}]`;
  if (!text) return prefix;
  return truncate(`${prefix}: ${text}`, 1000);
}

function stripUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/gi, "").trim();
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

function titleForFilter(type: MediaFilter): string {
  if (type === "image") return "Картинки";
  if (type === "video") return "Видео";
  return "Последние 10";
}

function formatDate(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 16);
}

function formatMoscowTime(date: Date): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function shutdown(): void {
  if (stopping) return;
  stopping = true;
  lifecycle.abort();
  console.log("[bot] stopping");
  for (const runningBot of bots) void runningBot.stop().catch((error) => logBotError("shutdown", error));
}
