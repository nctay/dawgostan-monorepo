import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Update } from "grammy/types";

const env = vi.hoisted(() => ({ TELEGRAM_CONVERTER_BOT_TOKEN: "123456:test-token", TELEGRAM_CONVERTER_ALLOWED_USERNAMES: "@Alice,BOB" }));
const db = vi.hoisted(() => ({
  converterUser: { findUnique: vi.fn(), createMany: vi.fn() },
  conversionRequest: { createMany: vi.fn() },
}));
vi.mock("./env.js", () => ({ env }));
vi.mock("./prisma.js", () => ({ prisma: db }));

import { createConverterBot } from "./converter.js";

function message(userId: number, username: string, text: string, updateId = 1): Update {
  return { update_id: updateId, message: {
    message_id: updateId, date: 1, chat: { id: userId, type: "private", first_name: username },
    from: { id: userId, is_bot: false, first_name: username, username }, text,
    ...(text === "/start" ? { entities: [{ type: "bot_command" as const, offset: 0, length: 6 }] } : {}),
  } };
}

function client() {
  const bot = createConverterBot()!;
  bot.botInfo = { id: 123456, is_bot: true, first_name: "Converter", username: "test_converter_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_manage_bots: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false };
  const sent: Array<{ method: string; payload: unknown }> = [];
  bot.api.config.use(async (_previous, method, payload) => {
    sent.push({ method, payload });
    return { ok: true, result: { message_id: 100, date: 1, chat: { id: 1, type: "private", first_name: "Test" } } } as Awaited<ReturnType<typeof _previous<typeof method>>>;
  });
  return { bot, sent };
}

describe("converter bot", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    env.TELEGRAM_CONVERTER_BOT_TOKEN = "123456:test-token";
    env.TELEGRAM_CONVERTER_ALLOWED_USERNAMES = "@Alice,BOB";
    db.converterUser.findUnique.mockResolvedValue(null);
  });

  it("denies a user outside the configured usernames", async () => {
    const { bot, sent } = client();
    await bot.handleUpdate(message(3, "mallory", "/start"));
    expect(sent).toContainEqual({ method: "sendMessage", payload: { chat_id: 3, text: "Доступ закрыт." } });
    expect(db.conversionRequest.createMany).not.toHaveBeenCalled();
  });

  it("binds a configured username on /start and retains access after a rename", async () => {
    const user = { username: "alice", telegramUserId: 1n };
    db.converterUser.findUnique.mockResolvedValueOnce(null).mockResolvedValue(user);
    const { bot, sent } = client();
    await bot.handleUpdate(message(1, "ALICE", "/start"));
    db.converterUser.findUnique.mockResolvedValue(user);
    await bot.handleUpdate(message(1, "renamed", "/start", 2));
    expect(sent.filter((entry) => entry.method === "sendMessage")).toEqual([
      { method: "sendMessage", payload: { chat_id: 1, text: "Пришли одну ссылку на видео: TikTok, Shorts, Reels или прямую видеоссылку. До 5 минут и 50 МБ." } },
      { method: "sendMessage", payload: { chat_id: 1, text: "Пришли одну ссылку на видео: TikTok, Shorts, Reels или прямую видеоссылку. До 5 минут и 50 МБ." } },
    ]);
  });

  it.each(["another owner", "revoked", "not started"])("denies access when the username is %s", async (reason) => {
    if (reason === "another owner") db.converterUser.createMany.mockResolvedValue({ count: 0 });
    if (reason === "revoked") {
      db.converterUser.findUnique.mockResolvedValue({ username: "alice", telegramUserId: 1n });
      env.TELEGRAM_CONVERTER_ALLOWED_USERNAMES = "bob";
    }
    const { bot, sent } = client();
    await bot.handleUpdate(message(1, "alice", reason === "not started" ? "https://example.com/video.mp4" : "/start"));
    expect(sent).toContainEqual({ method: "sendMessage", payload: { chat_id: 1, text: "Доступ закрыт." } });
    expect(db.conversionRequest.createMany).not.toHaveBeenCalled();
  });

  it("queues a video link for its sender using the persistent Telegram update id", async () => {
    db.converterUser.findUnique.mockResolvedValue({ username: "alice", telegramUserId: 1n });
    db.conversionRequest.createMany.mockResolvedValue({ count: 1 });
    const { bot, sent } = client();
    await bot.handleUpdate(message(1, "alice", "https://www.instagram.com/reel/Fixture/?igsh=shared"));
    expect(sent).toContainEqual({ method: "sendMessage", payload: { chat_id: 1, text: "Видео принято. Обрабатываю…" } });
    expect(db.conversionRequest.createMany).toHaveBeenCalledWith({
      skipDuplicates: true,
      data: { ownerId: 1n, chatId: 1n, telegramUpdateId: 1, sourceMessageId: 1, originalUrl: "https://www.instagram.com/reel/Fixture/?igsh=shared", normalizedUrl: "https://www.instagram.com/reel/Fixture/" },
    });
  });

  it.each(["no link", "https://example.com/photo.jpg", "https://example.com/a.mp4 https://example.com/b.mp4", "https://www.tiktok.com/@alice/photo/123"])("rejects a message that is not one video: %s", async (text) => {
    db.converterUser.findUnique.mockResolvedValue({ username: "alice", telegramUserId: 1n });
    const { bot, sent } = client();
    await bot.handleUpdate(message(1, "alice", text));
    expect(sent).toContainEqual({ method: "sendMessage", payload: { chat_id: 1, text: "Пришли одну ссылку на видео. Картинки и альбомы пока не поддерживаются." } });
    expect(db.conversionRequest.createMany).not.toHaveBeenCalled();
  });

  it("is disabled without a token", () => {
    env.TELEGRAM_CONVERTER_BOT_TOKEN = "";
    expect(createConverterBot()).toBeNull();
  });

  it("ignores messages outside the private chat", async () => {
    const { bot, sent } = client();
    const update = message(1, "alice", "https://example.com/video.mp4");
    if (update.message) update.message.chat = { id: -100, type: "group", title: "Test group" };
    await bot.handleUpdate(update);
    expect(sent).toEqual([]);
    expect(db.conversionRequest.createMany).not.toHaveBeenCalled();
  });
});
