import { Api, Bot, GrammyError } from "grammy";
import type { Update } from "grammy/types";
import { expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  streamSession: { findUnique: vi.fn() },
  chatPost: { findMany: vi.fn(), findFirst: vi.fn() },
  streamer: { findMany: vi.fn() },
  $disconnect: vi.fn(),
}));
vi.mock("node:timers/promises", () => import("./test-support/clock.js"));
vi.mock("./prisma.js", () => ({ prisma: db }));
vi.mock("./public-inbox.js", () => ({ PublicInboxError: class extends Error {}, publicInbox: () => ({
  recover: async () => [], accept: async (updates: Update[]) => {
    const { ackOnly } = await import("./public-page.js");
    return updates.map(update => update.callback_query?.id === "second-click" ? Object.assign(update, { [ackOnly]: true }) : update);
  },
  claimPage: async () => true, finish: async () => true, prune: async () => {},
}) }));
vi.mock("./env.js", () => ({
  env: { TELEGRAM_BOT_TOKEN: "1:admin", TELEGRAM_PUBLIC_BOT_TOKEN: "2:public" },
  allowedUserIds: new Set(), privateStreamerLogins: new Set(),
}));

const viewer = { id: 1, is_bot: false, first_name: "Viewer" };
function message(chatId: number, messageId: number) {
  return { message_id: messageId, date: 1, chat: { id: chatId, type: "private" as const, first_name: "Viewer" }, from: viewer };
}
function start(chatId: number, updateId: number): Update {
  return { update_id: updateId, message: { ...message(chatId, updateId), text: "/start", entities: [{ type: "bot_command", offset: 0, length: 6 }] } };
}

it.each([
  { scenario: "answers another chat before the second of 50 media with seven commands queued in the busy chat", offset: 0, failure: "none" },
  { scenario: "retries the Show more callback after a 503 and delivers each of the next 50 media once", offset: 50, failure: "callback" },
  { scenario: "retries a rejected header and copy in place without replaying accepted media", offset: 50, failure: "delivery" },
])("$scenario", async ({ offset, failure }) => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  const page = { update_id: 1, callback_query: {
    id: "callback", chat_instance: "archive", from: viewer, data: `pub:stream:session:${offset}`, message: message(1, 1),
  } };
  const startedAt = new Date();
  db.streamSession.findUnique.mockResolvedValue({ startedAt, streamer: { login: "streamer", displayName: "Streamer" } });
  const mediaIds = Array.from({ length: 50 }, (_, i) => offset + i + 1);
  const posts = mediaIds.map(id => ({
    id: String(id),
    assetId: String(id), postedAt: startedAt, authorName: "viewer", messageText: "",
    asset: { telegramChatId: "-100", telegramMessageId: id, telegramMessageIds: [] },
  }));
  db.chatPost.findMany.mockResolvedValue(posts);
  db.chatPost.findFirst.mockImplementation(async ({ where }) => posts.find(post => post.assetId === where.assetId));
  db.streamer.findMany.mockResolvedValue([{ id: "streamer", displayName: "Streamer" }]);
  vi.spyOn(Api.prototype, "getMe").mockResolvedValue({
    id: 2, is_bot: true, first_name: "Test", username: "archive_bot", can_join_groups: true,
    can_read_all_group_messages: false, supports_inline_queries: false, can_manage_bots: false,
    can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false,
  });
  vi.spyOn(Api.prototype, "deleteWebhook").mockResolvedValue(true);
  vi.spyOn(Api.prototype, "setMyCommands").mockResolvedValue(true);
  const ack = vi.spyOn(Api.prototype, "answerCallbackQuery").mockResolvedValue(true);
  if (failure === "callback") {
    ack.mockRejectedValueOnce(new GrammyError("unavailable", { ok: false, error_code: 503, description: "Service Unavailable" }, "answerCallbackQuery", {}));
  }
  const replies = vi.spyOn(Api.prototype, "sendMessage").mockResolvedValue({ ...message(2, 1), text: "" });
  if (failure === "delivery") {
    replies.mockRejectedValueOnce(new GrammyError("unavailable", { ok: false, error_code: 503, description: "Service Unavailable" }, "sendMessage", {}));
  }
  const delivered: number[] = [];
  let rejectedCopy = false;
  const copies = vi.spyOn(Api.prototype, "copyMessage").mockImplementation(async (_chat, _from, id) => {
    if (failure === "delivery" && id === mediaIds[24] && !rejectedCopy) {
      rejectedCopy = true;
      throw new GrammyError("unavailable", { ok: false, error_code: 503, description: "Service Unavailable" }, "copyMessage", {});
    }
    delivered.push(id);
    return { message_id: id };
  });
  const secondClick = { update_id: 2, callback_query: { ...page.callback_query, id: "second-click" } };
  const queued = Array.from({ length: 7 }, (_, index) => start(1, index + 3));
  const commands = [secondClick, ...queued, start(2, 10)];
  const inbox: Update[] = [page];
  const finished: number[] = [];
  const handleUpdate = Bot.prototype.handleUpdate;
  vi.spyOn(Bot.prototype, "handleUpdate").mockImplementation(async function (this: Bot, update) {
    await handleUpdate.call(this, update);
    finished.push(update.update_id);
  });
  let sendCommands!: () => void;
  const commandsReady = new Promise<void>((resolve) => { sendCommands = resolve; });
  vi.spyOn(Api.prototype, "getUpdates").mockImplementation(async function (this: Api, options: Parameters<Api["getUpdates"]>[0], signal) {
    if (!signal || options?.timeout === 0) return [];
    if (this.token === "2:public") {
      const limit = options?.limit ?? 100;
      if (inbox.length) return inbox.splice(0, limit);
      await commandsReady;
      if (commands.length) return commands.splice(0, limit);
    }
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return [];
  });
  const signals = ["SIGINT", "SIGTERM"] as const;
  const previousListeners = new Set(signals.flatMap(signal => process.listeners(signal)));
  function stopBots() {
    for (const signal of signals) {
      for (const listener of process.listeners(signal)) {
        if (previousListeners.has(listener)) continue;
        process.off(signal, listener);
        if (signal === "SIGTERM") listener(signal);
      }
    }
  }
  const running = import("./bot.js");
  try {
    const expectedAcks = failure === "callback" ? ["callback", "callback"] : ["callback"];
    await vi.waitFor(() => expect(ack.mock.calls.map(([id]) => id)).toEqual(expectedAcks), { interval: 5 });
    await vi.waitFor(() => expect(replies).toHaveBeenCalled(), { interval: 5 });
    expect(ack.mock.invocationCallOrder.at(-1)!).toBeLessThan(replies.mock.invocationCallOrder[0]!);
    // A rejected header also consumes a send slot before its successful retry.
    await vi.advanceTimersByTimeAsync(failure === "delivery" ? 2200 : 1100);
    expect(copies).toHaveBeenCalledTimes(1);
    sendCommands();
    await vi.advanceTimersByTimeAsync(0);
    const menus = () => replies.mock.calls.filter(([, text]) => text === "Выбери стримера:").map(([chat]) => chat);
    expect(menus()).toEqual([2]);
    expect(copies).toHaveBeenCalledTimes(1);
    if (failure !== "delivery") stopBots();
    await vi.advanceTimersByTimeAsync(0);
    expect(db.$disconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(delivered).toEqual(mediaIds);
    expect(copies).toHaveBeenCalledTimes(failure === "delivery" ? 51 : 50);
    expect(menus()).toEqual([2, ...Array(7).fill(1)]);
    expect(finished.filter(id => id >= 3 && id <= 9)).toEqual(queued.map(update => update.update_id));
    expect(db.chatPost.findMany).toHaveBeenCalledTimes(1);
    expect(db.chatPost.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: offset, take: 50 }));
    const footer = replies.mock.calls.findIndex(([, text]) => text === `Показано: ${offset + 50}`);
    expect(footer).toBeGreaterThanOrEqual(0);
    expect(footer).toBeLessThan(
      replies.mock.calls.findIndex(([chat, text]) => chat === 1 && text === "Выбери стримера:"),
    );
  } finally {
    sendCommands();
    stopBots();
    await vi.advanceTimersByTimeAsync(120_000);
    await running;
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});
