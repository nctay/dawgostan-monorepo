import { randomInt, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { Bot, type BotConfig, type Context } from "grammy";
import type { Update } from "grammy/types";
import { expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ apiRoot: "", capture: vi.fn() }));
vi.mock("grammy", async importOriginal => {
  const grammy = await importOriginal<typeof import("grammy")>();
  return { ...grammy, Bot: class extends grammy.Bot {
    constructor(token: string, config?: BotConfig<Context>) {
      super(token, { ...config, client: { ...config?.client, apiRoot: fixture.apiRoot } });
    }
  } };
});
vi.mock("./public-polling.js", () => ({ createPublicPolling: fixture.capture }));
vi.mock("./rate-limit.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./rate-limit.js")>();
  return { ...actual, ChatRateLimiter: class extends actual.ChatRateLimiter {
    constructor(_interval: number, signal: AbortSignal) { super(0, signal); }
  } };
});

vi.mock("node:timers/promises", async importOriginal => {
  const timers = await importOriginal<typeof import("node:timers/promises")>();
  return { ...timers, setTimeout: (ms: number, value: unknown, options: { signal?: AbortSignal }) =>
    timers.setTimeout(Math.min(ms, 10), value, options) };
});

const databaseUrl = process.env.PUBLIC_BOT_TEST_DATABASE_URL;
it.skipIf(!databaseUrl)("continues after repeated HTTP rejections and honors moderation during copy 41 and an album retry", async () => {
  const botId = randomInt(100_000, 1_000_000_000);
  vi.stubEnv("DATABASE_URL", databaseUrl!);
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "1:fixture");
  vi.stubEnv("TELEGRAM_PUBLIC_BOT_TOKEN", `${botId}:fixture`);
  vi.stubEnv("TELEGRAM_STORAGE_CHAT_ID", "-100");
  vi.stubEnv("TELEGRAM_ALLOWED_USER_IDS", "99");
  vi.stubEnv("TELEGRAM_CONVERTER_BOT_TOKEN", "");
  const { prisma } = await import("./prisma.js");
  const { publicInbox } = await import("./public-inbox.js");
  const prefix = randomUUID();
  const ids = Array.from({ length: 53 }, (_, i) => i + 1);
  const key = (id: number) => `${prefix}-${id}`;
  const requests: number[] = [];
  const delivered: number[] = [];
  const replies: string[] = [];
  let nextPage: string | undefined;
  let bot!: Bot;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    const method = request.url?.split("/").pop();
    let result: unknown = true;
    if (method === "getMe") result = { id: botId, is_bot: true, first_name: "Test", username: "fixture_bot" };
    if (method === "sendMessage") {
      replies.push(payload.text);
      nextPage = payload.reply_markup?.inline_keyboard.flat().find((button: { text: string }) => button.text === "Показать еще")?.callback_data ?? nextPage;
    }
    if (method === "copyMessage" || method === "copyMessages") {
      const id = payload.message_id ?? payload.message_ids[0];
      requests.push(id);
      if ((id === 25 || id === 26) && requests.filter(sent => sent === id).length <= 7) {
        if (id === 25) response.writeHead(503).end("Service Unavailable");
        else response.writeHead(429).end(JSON.stringify({
          ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 1 },
        }));
        return;
      }
      if (id === 41) {
        await prisma.chatPost.update({ where: { id: key(42) }, data: { messageText: "!skip_tg", skipTelegramPublic: true } });
        await prisma.asset.update({ where: { id: key(43) }, data: { visibility: "hidden" } });
      }
      if (id === 44 && requests.filter(sent => sent === id).length === 1) {
        await prisma.asset.update({ where: { id: key(44) }, data: { visibility: "hidden" } });
        response.writeHead(503).end("Service Unavailable");
        return;
      }
      delivered.push(id);
      result = method === "copyMessages" ? [{ message_id: id }] : { message_id: id };
    }
    response.end(JSON.stringify({ ok: true, result }));
  });
  const signals = ["SIGINT", "SIGTERM"] as const;
  const listeners = new Set(signals.flatMap(signal => process.listeners(signal)));
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test HTTP port");
    fixture.apiRoot = `http://127.0.0.1:${address.port}`;
    fixture.capture.mockImplementation((publicBot: Bot) => {
      bot = publicBot;
      return { start: async () => {}, stop: async () => {} };
    });
    vi.spyOn(Bot.prototype, "start").mockResolvedValue();
    await import("./bot.js");
    await bot.init();
    const streamer = await prisma.streamer.create({ data: { login: prefix, twitchUserId: prefix, displayName: "Fixture" } });
    const stream = await prisma.streamSession.create({ data: { streamerId: streamer.id, startedAt: new Date() } });
    await prisma.asset.createMany({ data: ids.map(id => ({
      id: key(id), originalUrl: key(id), normalizedUrl: key(id), status: "stored", telegramChatId: "-100", telegramMessageId: id,
      telegramMessageIds: id === 44 ? [44, 144] : [],
    })) });
    await prisma.chatPost.createMany({ data: ids.map(id => ({
      id: key(id), streamSessionId: stream.id, assetId: key(id), status: "stored", authorName: "viewer", messageText: "",
      originalUrl: key(id), normalizedUrl: key(id), postedAt: new Date((100 - id) * 1000),
    })) });
    await prisma.chatPost.create({ data: {
      id: key(61), streamSessionId: stream.id, assetId: key(51), status: "stored", skipTelegramPublic: true,
      authorName: "private-viewer", messageText: "!skip_tg", originalUrl: key(51), normalizedUrl: key(51), postedAt: new Date(200_000),
    } });
    const ordered = [51, ...ids.filter(id => id !== 51)];
    const user = { id: 12, is_bot: false, first_name: "Viewer" };
    const update: Update = { update_id: 1, callback_query: { id: "show", from: user, chat_instance: "test",
      data: `pub:stream:${stream.id}:0`, message: { message_id: 1, date: 1, chat: { id: 12, type: "private", first_name: "Viewer" } },
    } };
    await publicInbox(botId).accept([update]);
    await bot.handleUpdate(update);
    expect(delivered).toEqual(ordered.slice(0, 50).filter(id => ![42, 43, 44].includes(id)));
    for (const id of [25, 26]) expect(requests.filter(sent => sent === id)).toHaveLength(8);
    expect(requests.filter(id => id === 44)).toEqual([44]);
    expect(replies.at(-1)).toBe("Показано: 47");
    expect(nextPage).toBeDefined();
    expect(Buffer.byteLength(nextPage!)).toBeLessThanOrEqual(64);
    // The boundary itself can become private. An older duplicate must also
    // stay out of the next page, even though it sorts below that boundary.
    await prisma.chatPost.updateMany({ where: { id: { in: [key(49), key(10)] } }, data: { skipTelegramPublic: true } });
    await prisma.chatPost.create({ data: {
      id: key(99), streamSessionId: stream.id, assetId: key(10), status: "stored", authorName: "viewer", messageText: "",
      originalUrl: key(10), normalizedUrl: key(10), postedAt: new Date(0),
    } });
    const next: Update = { update_id: 2, callback_query: { ...update.callback_query!, id: "next", data: nextPage! } };
    await publicInbox(botId).accept([next]);
    await bot.handleUpdate(next);
    expect(delivered).toEqual(ordered.filter(id => ![42, 43, 44].includes(id)));
    expect(replies.at(-1)).toBe("Показано: 50");
  } finally {
    for (const signal of signals) {
      for (const listener of process.listeners(signal)) if (!listeners.has(listener)) process.off(signal, listener);
    }
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.publicBotUpdate.deleteMany({ where: { botId } });
    await prisma.streamer.deleteMany({ where: { login: prefix } });
    await prisma.asset.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.$disconnect();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  }
}, 15_000);
