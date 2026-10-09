import { Bot, GrammyError, InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import type { Prisma } from "@prisma/client";
import { allowedUserIds, env, privateStreamerLogins } from "./env.js";
import { prisma } from "./prisma.js";
import { SerialRateLimiter, withTelegramRetry } from "./rate-limit.js";
import { logBotAlert } from "./alert-log.js";

const pageSize = 10;
const publicPageSize = 50;
const bots: Bot[] = [];
const publicChatLimiters = new Map<number | string, SerialRateLimiter>();

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

const publicBot = env.TELEGRAM_PUBLIC_BOT_TOKEN ? new Bot(env.TELEGRAM_PUBLIC_BOT_TOKEN) : null;
if (publicBot) {
  bots.push(publicBot);

  publicBot.command("start", async (ctx) => {
    await sendPublicStreamers(ctx, 0);
  });

  publicBot.command("streamers", async (ctx) => {
    await sendPublicStreamers(ctx, 0);
  });

  publicBot.callbackQuery(/^pub:streamers:(\d+)$/, async (ctx) => {
    await answerCallbackQuerySafely(ctx);
    await sendPublicStreamers(ctx, Number(ctx.match[1]));
  });

  publicBot.callbackQuery(/^pub:streamer:([^:]+):(\d+)$/, async (ctx) => {
    await answerCallbackQuerySafely(ctx);
    await sendPublicStreams(ctx, ctx.match[1]!, Number(ctx.match[2]));
  });

  publicBot.callbackQuery(/^pub:stream:([^:]+):(\d+)$/, async (ctx) => {
    await answerCallbackQuerySafely(ctx);
    await sendPublicMessages(ctx, ctx.match[1]!, Number(ctx.match[2]));
  });

  publicBot.catch((error) => logBotError("public-bot", error));
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await withTelegramRetry(() =>
  adminBot.api.setMyCommands([
    { command: "start", description: "Меню" },
    { command: "live", description: "Live-стримы" },
    { command: "streams", description: "Последние стримы" },
    { command: "latest", description: "Последние 10 медиа" },
    { command: "stream", description: "Медиа стрима по id" },
  ]),
);

if (publicBot) {
  await withTelegramRetry(() =>
    publicBot.api.setMyCommands([
      { command: "start", description: "Выбрать стримера" },
      { command: "streamers", description: "Список стримеров" },
    ]),
  );
}

console.log(`[bot] starting admin${publicBot ? " and public" : ""}`);
await Promise.all(bots.map((runningBot) => runningBot.start()));

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
  const botError = error as { error?: unknown; ctx?: Context; name?: string };
  const cause = botError.error ?? error;
  logBotAlert({
    scope,
    error: cause,
    details: {
      update_id: botError.ctx?.update.update_id,
      handler: botError.name,
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

async function sendPublicMessages(ctx: Context, streamId: string, offset: number): Promise<void> {
  const session = await prisma.streamSession.findUnique({
    where: { id: streamId },
    include: { streamer: true },
  });
  if (!session) {
    await ctx.reply("Стрим не найден.");
    return;
  }
  if (!canAccessPublicStreamer(ctx, session.streamer.login)) {
    await ctx.reply("Стрим не найден.");
    return;
  }

  const posts = await prisma.chatPost.findMany({
    where: {
      streamSessionId: streamId,
      ...publicStoredPostWhere(),
    },
    orderBy: { postedAt: "desc" },
    distinct: ["assetId"],
    skip: offset,
    take: publicPageSize,
    include: { asset: true },
  });

  if (posts.length === 0) {
    await ctx.reply("Сообщений больше нет.");
    return;
  }

  const keyboard = new InlineKeyboard()
    .text("Назад к датам", `pub:streamer:${session.streamerId}:0`)
    .row()
    .text("Показать еще", `pub:stream:${streamId}:${offset + publicPageSize}`);

  await withTelegramRetry(() => ctx.reply(`${session.streamer.displayName} / ${formatDate(session.startedAt)}`));

  let copied = 0;
  for (const post of uniquePostsByAsset(posts)) {
    const asset = post.asset;
    if (!asset?.telegramChatId || !asset.telegramMessageId) continue;

    if (asset.telegramMessageIds.length > 1) {
      const copied = await schedulePublicChatMessage(ctx.chat!.id, () =>
        ctx.api.copyMessages(ctx.chat!.id, asset.telegramChatId!, asset.telegramMessageIds, { remove_caption: true }),
      );
      if (copied[0]) {
        await schedulePublicChatMessage(ctx.chat!.id, () =>
          ctx.api.editMessageCaption(ctx.chat!.id, copied[0]!.message_id, { caption: publicMediaCaption(post) }),
        );
      }
    } else {
      await schedulePublicChatMessage(ctx.chat!.id, () =>
        ctx.api.copyMessage(ctx.chat!.id, asset.telegramChatId!, asset.telegramMessageId!, {
          caption: publicMediaCaption(post),
        }),
      );
    }
    copied += 1;
  }

  if (copied === 0) {
    await withTelegramRetry(() => ctx.reply("В этой пачке нет доступных Telegram-медиа."));
  }

  await schedulePublicChatMessage(ctx.chat!.id, () => ctx.reply(`Показано: ${offset + copied}`, { reply_markup: keyboard }));
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

function schedulePublicChatMessage<T>(chatId: number | string, task: () => Promise<T>): Promise<T> {
  let limiter = publicChatLimiters.get(chatId);
  if (!limiter) {
    limiter = new SerialRateLimiter(1100);
    publicChatLimiters.set(chatId, limiter);
  }
  return limiter.schedule(task);
}

function stripUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/gi, "").trim();
}

function stripSkipTelegramPublicTag(text: string): string {
  return text.replace(/!skip_tg(?=https?:\/\/|\s|$)/gi, " ").replace(/\s+/g, " ").trim();
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

async function shutdown(): Promise<void> {
  console.log("[bot] stopping");
  for (const runningBot of bots) runningBot.stop();
  await prisma.$disconnect();
}
