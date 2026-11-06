import { Bot } from "grammy";
import { extractUrls, isPlatformMediaUrl, mediaTypeFromUrl, normalizeUrl, toUrl } from "@dawgostan/core";
import { env } from "./env.js";
import { prisma } from "./prisma.js";

export function createConverterBot(): Bot | null {
  if (!env.TELEGRAM_CONVERTER_BOT_TOKEN) return null;
  const bot = new Bot(env.TELEGRAM_CONVERTER_BOT_TOKEN);
  const allowed = new Set(env.TELEGRAM_CONVERTER_ALLOWED_USERNAMES.split(",").map((name) => name.trim().replace(/^@/, "").toLowerCase()).filter(Boolean));

  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== "private" || !ctx.from) return;
    const userId = BigInt(ctx.from.id);
    let user = await prisma.converterUser.findUnique({ where: { telegramUserId: userId } });
    const username = ctx.from.username?.toLowerCase();
    if (!user && ctx.hasCommand("start") && username && allowed.has(username)) {
      await prisma.converterUser.createMany({ data: { username, telegramUserId: userId }, skipDuplicates: true });
      user = await prisma.converterUser.findUnique({ where: { telegramUserId: userId } });
    }
    if (!user || user.telegramUserId !== userId || !allowed.has(user.username)) {
      await ctx.reply("Доступ закрыт.");
      return;
    }
    await next();
  });
  bot.command("start", (ctx) => ctx.reply("Пришли одну ссылку на видео: TikTok, Shorts, Reels или прямую видеоссылку. До 5 минут и 50 МБ."));
  bot.on("message:text", async (ctx) => {
    const urls = extractUrls(ctx.message.text);
    const rawUrl = urls[0];
    const url = rawUrl ? toUrl(rawUrl) : null;
    if (urls.length !== 1 || !url || !(mediaTypeFromUrl(url.toString()) === "video" || isPlatformMediaUrl(url.toString())) || /^\/@[^/]+\/photo\//.test(url.pathname)) {
      await ctx.reply("Пришли одну ссылку на видео. Картинки и альбомы пока не поддерживаются.");
      return;
    }
    await prisma.conversionRequest.createMany({
      skipDuplicates: true,
      data: {
        ownerId: BigInt(ctx.from.id), chatId: BigInt(ctx.chat.id),
        telegramUpdateId: ctx.update.update_id, sourceMessageId: ctx.message.message_id,
        originalUrl: rawUrl!, normalizedUrl: normalizeUrl(rawUrl!)!,
      },
    });
    await ctx.reply("Видео принято. Обрабатываю…");
  });
  return bot;
}
