import { Prisma } from "@prisma/client";
import { Bot, GrammyError, HttpError } from "grammy";
import type { Update } from "grammy/types";
import { beforeEach, expect, it, vi } from "vitest";
import { format } from "node:util";
import { createPublicPolling } from "./public-polling.js";

const store = vi.hoisted(() => ({
  recover: vi.fn(async (): Promise<Update[]> => []),
  accept: vi.fn(async (updates: Update[]) => updates),
  prune: vi.fn(async () => {}),
}));
vi.mock("./public-inbox.js", () => ({ PublicInboxError: class extends Error {}, publicInbox: () => store }));
beforeEach(() => {
  store.recover.mockReset().mockResolvedValue([]);
  store.accept.mockReset().mockImplementation(async updates => updates);
  store.prune.mockReset().mockResolvedValue(undefined);
});

function chatUpdate(updateId: number, chatId: number): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId, date: 1, chat: { id: chatId, type: "private", first_name: "Viewer" },
      from: { id: chatId, is_bot: false, first_name: "Viewer" }, text: "/start",
    },
  };
}

function testBot(inbox: Update[], handle: (update: Update) => Promise<void>) {
  const bot = new Bot("1:test");
  vi.spyOn(bot.api, "getMe").mockResolvedValue({
    id: 1, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: true,
    can_read_all_group_messages: false, supports_inline_queries: false, can_manage_bots: false,
    can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false,
  });
  vi.spyOn(bot, "handleUpdate").mockImplementation(handle);
  vi.spyOn(bot.api, "deleteWebhook").mockResolvedValue(true);
  vi.spyOn(bot.api, "getUpdates").mockImplementation(async (options, signal) => {
    // Telegram retains delivered updates until a later request advances the offset.
    while (inbox.length && inbox[0]!.update_id < (options?.offset ?? 0)) inbox.shift();
    if (!inbox.length && options?.timeout !== 0 && signal && !signal.aborted) {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    }
    return inbox.slice(0, options?.limit ?? 100);
  });
  return bot;
}

it.each(["recover", "prune", "accept"] as const)("stops promptly during a persistent database outage in %s", async operation => {
  store[operation].mockRejectedValue(new Prisma.PrismaClientKnownRequestError("offline", { code: "P1001", clientVersion: "test" }));
  const bot = testBot([chatUpdate(1, 1)], async () => {});
  const polling = createPublicPolling(bot);
  const running = polling.start();
  void running.catch(() => {});
  try {
    await vi.waitFor(() => expect(store[operation].mock.calls.length).toBeGreaterThan(1));
    expect(bot.handleUpdate).not.toHaveBeenCalled();
  } finally {
    await polling.stop();
    await running;
  }
  expect(vi.mocked(bot.api.getUpdates).mock.calls.map(([options]) => options?.offset)).not.toContain(2);
});

it("skips a recovered update still being handled when Telegram redelivers it", async () => {
  const first = chatUpdate(10, 1);
  const second = chatUpdate(11, 2);
  store.recover.mockResolvedValueOnce([first]);
  let release!: () => void;
  const busy = new Promise<void>(resolve => { release = resolve; });
  const bot = testBot([first, second], async update => { if (update.update_id === first.update_id) await busy; });
  const polling = createPublicPolling(bot);
  const running = polling.start();
  try {
    await vi.waitFor(() => expect(vi.mocked(bot.api.getUpdates).mock.calls.some(([options]) => options?.offset === 12)).toBe(true));
    expect(vi.mocked(bot.handleUpdate).mock.calls.map(([update]) => update.update_id)).toEqual([10, 11]);
  } finally {
    const stopping = polling.stop();
    release();
    await Promise.all([running, stopping]);
  }
});

it("propagates a permanent schema error on inbox recovery", async () => {
  const error = new Prisma.PrismaClientKnownRequestError("table missing", { code: "P2021", clientVersion: "test" });
  store.recover.mockRejectedValue(error);
  const bot = testBot([], async () => {});
  await expect(createPublicPolling(bot).start()).rejects.toBe(error);
  expect(store.recover).toHaveBeenCalledOnce();
  expect(bot.api.getUpdates).not.toHaveBeenCalled();
});

it("confirms the full busy batch on shutdown and leaves newer updates for the next process", async () => {
  const inbox = Array.from({ length: 9 }, (_, i) => chatUpdate(i + 1, i + 1));
  let release!: () => void;
  const busy = new Promise<void>(resolve => { release = resolve; });
  const firstHandler = vi.fn(async () => busy);
  const first = createPublicPolling(testBot(inbox, firstHandler));
  const firstRun = first.start();
  try {
    await vi.waitFor(() => expect(firstHandler).toHaveBeenCalledTimes(8));
  } finally {
    const stopping = first.stop();
    release();
    await Promise.all([stopping, firstRun]);
  }

  const handled: number[] = [];
  const second = createPublicPolling(testBot(inbox, async update => { handled.push(update.update_id); }));
  const secondRun = second.start();
  try {
    await vi.waitFor(() => expect(handled).toContain(9));
    expect(handled).toEqual([9]);
  } finally {
    await second.stop();
    await secondRun;
  }
});

it("keeps a network error's token out of polling logs and resets the old Telegram update filter", async () => {
  const bot = testBot([chatUpdate(1, 1)], async () => {});
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const fetch = vi.mocked(bot.api.getUpdates);
  fetch.mockRejectedValueOnce(new HttpError("network failure", new Error(`request to https://api.telegram.org/bot${bot.token}/getUpdates failed`)));
  const polling = createPublicPolling(bot);
  const running = polling.start();
  try {
    await vi.waitFor(() => expect(bot.handleUpdate).toHaveBeenCalledOnce());
    const output = log.mock.calls.map(args => format(...args)).join("\n");
    expect(output).toContain("getUpdates");
    expect(output).not.toContain(bot.token);
    expect(fetch.mock.calls[0]?.[0]?.allowed_updates).toEqual([]);
  } finally {
    await polling.stop();
    await running;
    log.mockRestore();
  }
});

it("keeps retrying a prolonged outage until startup succeeds", async () => {
  const bot = testBot([chatUpdate(1, 1)], async () => {});
  const remove = vi.mocked(bot.api.deleteWebhook);
  for (let i = 0; i < 6; i++) {
    remove.mockRejectedValueOnce(new GrammyError("unavailable", { ok: false, error_code: 503, description: "unavailable" }, "deleteWebhook", {}));
  }
  const polling = createPublicPolling(bot);
  const running = polling.start();
  try {
    await vi.waitFor(() => expect(bot.handleUpdate).toHaveBeenCalledOnce(), { timeout: 10_000 });
    expect(remove).toHaveBeenCalledTimes(7);
  } finally {
    await polling.stop();
    await running;
  }
}, 12_000);

it("buffers at most 100 updates when one chat stays busy", async () => {
  const inbox = Array.from({ length: 101 }, (_, i) => chatUpdate(i + 1, 1));
  let release!: () => void;
  const busy = new Promise<void>(resolve => { release = resolve; });
  const handle = vi.fn(async () => busy);
  const polling = createPublicPolling(testBot(inbox, handle));
  const running = polling.start();
  try {
    await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(100));
  } finally {
    const stopping = polling.stop();
    release();
    await Promise.all([stopping, running]);
  }
  expect(handle).toHaveBeenCalledTimes(100);
  expect(inbox.map(update => update.update_id)).toEqual([101]);
});

it.each([
  new GrammyError("Temporary outage", { ok: false, error_code: 503, description: "Service Unavailable" }, "deleteWebhook", {}),
  new HttpError("Invalid gateway response", new SyntaxError("Expected JSON")),
])("starts polling after a temporary deleteWebhook failure: %s", async error => {
  let processed!: () => void;
  const received = new Promise<void>(resolve => { processed = resolve; });
  const bot = testBot([{ update_id: 1 }], async () => processed());
  vi.mocked(bot.api.deleteWebhook).mockRejectedValueOnce(error);
  const polling = createPublicPolling(bot);
  const running = polling.start();
  try {
    await Promise.race([running, received]);
    expect(bot.api.deleteWebhook).toHaveBeenCalledTimes(2);
    expect(bot.handleUpdate).toHaveBeenCalledOnce();
  } finally {
    await polling.stop();
    await running;
  }
});
