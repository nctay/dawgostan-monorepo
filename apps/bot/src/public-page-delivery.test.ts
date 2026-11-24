import { Readable } from "node:stream";
import fetch, { Response as NodeResponse } from "node-fetch";
import { Bot, type BotConfig, type Context } from "grammy";
import type { Update } from "grammy/types";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), posts: vi.fn(), byId: vi.fn(), finish: vi.fn(), polling: vi.fn(), fetch: vi.fn(),
}));
vi.mock("node:timers/promises", () => import("./test-support/clock.js"));
vi.mock("node-fetch", async importOriginal => {
  const original = await importOriginal<typeof import("node-fetch")>();
  return { ...original, default: mocks.fetch };
});
vi.mock("./prisma.js", () => ({ prisma: {
  streamSession: { findUnique: mocks.session }, chatPost: { findMany: mocks.posts, findFirst: mocks.byId },
  streamer: { findMany: async () => [] }, $disconnect: async () => {},
} }));
vi.mock("./public-inbox.js", () => ({
  PublicInboxError: class extends Error {}, publicInbox: () => ({ claimPage: async () => true, finish: mocks.finish }),
}));
vi.mock("./public-polling.js", () => ({ createPublicPolling: mocks.polling }));
vi.mock("./env.js", () => ({
  env: { TELEGRAM_BOT_TOKEN: "1:admin", TELEGRAM_PUBLIC_BOT_TOKEN: "2:public" },
  allowedUserIds: new Set(), privateStreamerLogins: new Set(["private"]),
}));
vi.mock("grammy", async importOriginal => {
  const original = await importOriginal<typeof import("grammy")>();
  return { ...original, Bot: class extends original.Bot {
    constructor(token: string, config?: BotConfig<Context>) {
      super(token, { ...config, client: { fetch: Object.assign(mocks.fetch, fetch), ...config?.client } });
    }
  } };
});

const viewer = { id: 1, is_bot: false, first_name: "Viewer" };
const message = { message_id: 1, date: 1, chat: { id: 1, type: "private" as const, first_name: "Viewer" } };
function click(id: number, offset = 0): Update {
  return { update_id: id, callback_query: {
    id: String(id), from: viewer, message, chat_instance: "archive", data: `pub:stream:session:${offset}`,
  } };
}
function post(id: number, album = false) {
  return {
    id: String(id), assetId: String(id), postedAt: new Date(0), authorName: "viewer", messageText: "",
    asset: { telegramChatId: "-100", telegramMessageId: id, telegramMessageIds: album ? [id, id + 1] : [] },
  };
}

let bot: Bot;
let headerDelay: number;
const calls: { method: string; id: number | string; at: number }[] = [];
let reject: (method: string, id: number | string) => Response | undefined;
const signals = ["SIGINT", "SIGTERM"] as const;
let oldListeners: Set<NodeJS.SignalsListener>;
beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  oldListeners = new Set(signals.flatMap(signal => process.listeners(signal)));
  calls.length = 0;
  headerDelay = 0;
  reject = () => undefined;
  mocks.session.mockResolvedValue({ streamerId: "s", streamer: { login: "s", displayName: "Stream" }, startedAt: new Date(0) });
  mocks.posts.mockResolvedValue([post(1), post(2), post(3, true)]);
  mocks.byId.mockImplementation(async ({ where }) => post(Number(where.assetId), where.assetId === "3"));
  mocks.finish.mockImplementation(async id => {
    calls.push({ method: "finish", id, at: Date.now() });
    return true;
  });
  mocks.polling.mockImplementation((publicBot: Bot) => {
    bot = publicBot;
    return { start: async () => {}, stop: async () => {} };
  });
  vi.spyOn(Bot.prototype, "start").mockResolvedValue();
  mocks.fetch.mockImplementation(async (url: string | URL, init: RequestInit) => {
    const method = new URL(url).pathname.split("/").at(-1)!;
    const payload = JSON.parse(String(init.body));
    const id = payload.text ?? payload.callback_query_id ?? payload.message_ids?.[0] ?? payload.message_id ?? 0;
    calls.push({ method, id, at: Date.now() });
    if (headerDelay && method === "sendMessage" && String(id).startsWith("Stream /")) {
      await new Promise(resolve => setTimeout(resolve, headerDelay));
    }
    const error = reject(method, id);
    if (error) return new NodeResponse(Readable.from([Buffer.from(await error.text())]), { status: error.status });
    const result = method === "getMe" ? { id: 2, is_bot: true, first_name: "Test", username: "archive_bot" }
      : method === "copyMessages" ? [{ message_id: 3 }, { message_id: 4 }]
      : method === "copyMessage" ? { message_id: id } : true;
    return new NodeResponse(Readable.from([Buffer.from(JSON.stringify({ ok: true, result }))]));
  });
  await import("./bot.js");
  await bot.init();
});
afterEach(() => {
  for (const signal of signals) {
    for (const listener of process.listeners(signal)) if (!oldListeners.has(listener)) process.off(signal, listener);
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("retries plain HTTP 503 for a single copy and an album without replaying earlier deliveries", async () => {
  const failures = new Set([2, 3]);
  reject = (method, id) => method.startsWith("copyMessage") && failures.delete(Number(id))
    ? new Response("Service Unavailable", { status: 503 }) : undefined;
  const handling = bot.handleUpdate(click(1));
  await vi.advanceTimersByTimeAsync(20_000);
  await handling;
  expect(calls.filter(c => c.method.startsWith("copyMessage")).map(c => c.id)).toEqual([1, 2, 2, 3, 3]);
  expect(calls.filter(c => c.method === "editMessageCaption")).toHaveLength(1);
  expect(calls.filter(c => c.id === "Показано: 3")).toHaveLength(1);
});

it.each([503, 429])("survives seven HTTP %i rejections of copy 25 with another chat active", async status => {
  const ids = Array.from({ length: 50 }, (_, index) => index + 1);
  mocks.posts.mockResolvedValue(ids.map(id => post(id, id === 25 && status === 429)));
  mocks.byId.mockImplementation(async ({ where }) => post(Number(where.assetId), where.assetId === "25" && status === 429));
  const delivered: number[] = [];
  let rejects = 0;
  reject = (method, id) => {
    if (!method.startsWith("copyMessage")) return;
    if (id === 25 && rejects++ < 7) {
      return status === 503 ? new Response("Service Unavailable", { status })
        : Response.json({ ok: false, error_code: 429, description: "Slow down", parameters: { retry_after: 2 } }, { status });
    }
    delivered.push(Number(id));
  };
  const page = bot.handleUpdate(click(1));
  await vi.advanceTimersByTimeAsync(27_500);
  expect(delivered).toEqual(ids.slice(0, 24));
  expect(rejects).toBe(1);
  await bot.handleUpdate({ update_id: 2, message: { ...message, from: viewer, chat: { ...message.chat, id: 2 },
    text: "/start", entities: [{ type: "bot_command", offset: 0, length: 6 }],
  } });
  expect(calls.some(call => call.id === "Публичных стримеров пока нет.")).toBe(true);
  await vi.advanceTimersByTimeAsync(240_000);
  await page;
  expect(delivered).toEqual(ids);
  expect(calls.filter(c => c.id === 25 && c.method === (status === 503 ? "copyMessage" : "copyMessages"))).toHaveLength(8);
  expect(calls.filter(c => c.id === "Показано: 50")).toHaveLength(1);
});

it("keeps an ambiguous socket reset after a copy at most once", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  reject = method => {
    if (method === "copyMessage") throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    return undefined;
  };
  const page = bot.handleUpdate(click(1));
  await vi.advanceTimersByTimeAsync(80_000);
  await page;
  expect(calls.filter(c => c.method === "copyMessage").map(c => c.id)).toEqual([1]);
});

it("does not resend an empty-page reply if Telegram closes the connection after receiving it", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.posts.mockResolvedValue([]);
  let reset = true;
  reject = (method, id) => {
    if (reset && method === "sendMessage" && id === "Сообщений больше нет.") {
      reset = false;
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    }
    return undefined;
  };
  const page = bot.handleUpdate(click(1));
  await vi.advanceTimersByTimeAsync(5000);
  await page;
  expect(calls.filter(c => c.id === "Сообщений больше нет.")).toHaveLength(1);
});

it("releases the claimed page on shutdown during a Telegram retry_after wait", async () => {
  const limited = Response.json({ ok: false, error_code: 429, description: "Slow down", parameters: { retry_after: 300 } }, { status: 429 });
  reject = method => method === "copyMessage" ? limited.clone() : undefined;
  const page = bot.handleUpdate(click(1));
  await vi.advanceTimersByTimeAsync(1100);
  expect(calls.filter(c => c.method === "copyMessage")).toHaveLength(1);
  for (const listener of process.listeners("SIGTERM")) if (!oldListeners.has(listener)) listener("SIGTERM");
  await vi.advanceTimersByTimeAsync(1100);
  expect(mocks.finish).toHaveBeenCalledOnce();
  await page;
  expect(calls.filter(c => c.method === "copyMessage")).toHaveLength(1);
});

it("does not repeat a copy after a malformed HTTP 200 with unknown delivery outcome", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  reject = method => method === "copyMessage" ? new Response("2:public") : undefined;
  const handling = bot.handleUpdate(click(1));
  await vi.advanceTimersByTimeAsync(40_000);
  await handling;
  expect(calls.filter(c => c.method === "copyMessage").map(c => c.id)).toEqual([1]);
  expect(log).toHaveBeenCalled();
  expect(JSON.stringify(log.mock.calls)).not.toContain("2:public");
});

it.each(["Стрим не найден.", "Сообщений больше нет."])("delivers '%s' before finishing its update", async text => {
  if (text === "Стрим не найден.") mocks.session.mockResolvedValue(null);
  mocks.posts.mockResolvedValue([]);
  let failed = false;
  reject = (method, id) => {
    if (method === "sendMessage" && id === text && !failed) {
      failed = true;
      return Response.json({ ok: false, error_code: 503, description: "Service Unavailable" }, { status: 503 });
    }
  };
  const handling = bot.handleUpdate(click(1));
  await vi.advanceTimersByTimeAsync(3_000);
  await handling;
  expect(calls.filter(c => ["answerCallbackQuery", "sendMessage", "finish"].includes(c.method)).map(c => c.id)).toEqual(["1", text, text, 1]);
});

it("retries only the duplicate ACK on a 503 while the original page sends", async () => {
  const first = click(1);
  const { ackOnly } = await import("./public-page.js");
  const duplicate = Object.assign(click(2), { [ackOnly]: true });
  let failed = false;
  reject = (method, id) => {
    if (method === "answerCallbackQuery" && id === "2" && !failed) {
      failed = true;
      return Response.json({ ok: false, error_code: 503, description: "Service Unavailable" }, { status: 503 });
    }
  };
  const original = bot.handleUpdate(first);
  await vi.advanceTimersByTimeAsync(1100);
  const second = bot.handleUpdate(duplicate);
  await vi.advanceTimersByTimeAsync(20_000);
  await Promise.all([original, second]);
  expect(calls.filter(c => c.id === "2" || (c.method === "finish" && c.id === 2)).map(c => c.method))
    .toEqual(["answerCallbackQuery", "answerCallbackQuery", "finish"]);
  expect(mocks.posts).toHaveBeenCalledOnce();
  expect(calls.filter(c => c.method.startsWith("copyMessage")).map(c => c.id)).toEqual([1, 2, 3]);
});

it("spaces two pages in the same chat while another chat receives its menu immediately", async () => {
  mocks.posts.mockResolvedValue([post(1)]);
  const pages = Promise.all([bot.handleUpdate(click(1)), bot.handleUpdate(click(2, 50))]);
  await vi.advanceTimersByTimeAsync(1100);
  const menuAt = Date.now();
  await bot.handleUpdate({ update_id: 3, message: { ...message, from: viewer, chat: { ...message.chat, id: 2 },
    text: "/start", entities: [{ type: "bot_command", offset: 0, length: 6 }],
  } });
  expect(calls.find(c => c.id === "Публичных стримеров пока нет.")?.at).toBe(menuAt);
  await vi.advanceTimersByTimeAsync(20_000);
  await pages;
  const headers = calls.filter(c => typeof c.id === "string" && c.id.startsWith("Stream /"));
  expect(headers[1]!.at - calls.find(c => c.id === "Показано: 1")!.at).toBeGreaterThanOrEqual(1100);
});


it("starts the next send as soon as a slow Telegram reply finishes", async () => {
  headerDelay = 1500;
  mocks.posts.mockResolvedValue([post(1)]);
  const handling = bot.handleUpdate(click(1));
  await vi.advanceTimersByTimeAsync(10_000);
  await handling;
  const header = calls.find(c => String(c.id).startsWith("Stream /"))!;
  expect(calls.find(c => c.method === "copyMessage")!.at - header.at).toBe(headerDelay);
});

it("releases an idle chat only after the final queued send's cooldown", async () => {
  const { ChatRateLimiter } = await import("./rate-limit.js");
  const limiter = new ChatRateLimiter(1100, new AbortController().signal);
  const calls = vi.fn(async () => {});
  const pending = Promise.all([limiter.schedule(1, calls), limiter.schedule(1, calls)]);
  await vi.advanceTimersByTimeAsync(1100);
  await pending;
  expect(calls).toHaveBeenCalledTimes(2);
  expect(limiter["cooldowns"].size).toBe(1);
  await vi.advanceTimersByTimeAsync(1100);
  expect(limiter["cooldowns"].size).toBe(0);
});

it.each(["empty", "missing", "hidden"])("paces the %s page reply after the previous footer", async scenario => {
  mocks.posts.mockResolvedValueOnce([post(1)]).mockResolvedValueOnce([]);
  if (scenario !== "empty") {
    mocks.session.mockResolvedValueOnce({ streamerId: "s", streamer: { login: "s", displayName: "Stream" }, startedAt: new Date(0) });
    mocks.session.mockResolvedValueOnce(scenario === "missing" ? null : { streamer: { login: "private" } });
  }
  const pages = Promise.all([bot.handleUpdate(click(1)), bot.handleUpdate(click(2, 50))]);
  await vi.advanceTimersByTimeAsync(2200);
  const menuAt = Date.now();
  await bot.handleUpdate({ update_id: 3, message: { ...message, from: viewer, chat: { ...message.chat, id: 2 },
    text: "/start", entities: [{ type: "bot_command", offset: 0, length: 6 }],
  } });
  expect(calls.find(c => c.id === "Публичных стримеров пока нет.")?.at).toBe(menuAt);
  await vi.advanceTimersByTimeAsync(2200);
  await pages;
  const reply = calls.find(c => c.id === (scenario === "empty" ? "Сообщений больше нет." : "Стрим не найден."));
  expect(reply!.at - calls.find(c => c.id === "Показано: 1")!.at).toBeGreaterThanOrEqual(1100);
  expect(calls.indexOf(reply!)).toBeLessThan(calls.findIndex(c => c.method === "finish" && c.id === 2));
});
