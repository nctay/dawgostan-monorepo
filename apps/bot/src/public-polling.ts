import { createConcurrentSink, createRunner, createSource } from "@grammyjs/runner";
import { BotError, Context, type Bot } from "grammy";
import type { Update } from "grammy/types";
import { telegramCall, telegramSignal } from "./rate-limit.js";
import { retryInbox } from "./database-errors.js";
import { publicInbox, PublicInboxError } from "./public-inbox.js";

export function createPublicPolling(bot: Bot) {
  const maxActiveChats = 8;
  const maxPendingUpdates = 100;
  const lifecycle = new AbortController();
  let inbox: ReturnType<typeof publicInbox>;
  let recovered: Update[] = [];
  let nextPrune = 0;
  let offset = 0;
  let offsetToConfirm: number | undefined;
  const inFlight = new Set<number>();

  const source = createSource({
    async supply(limit, signal) {
      if (recovered.length) return recovered.splice(0, limit);
      if (Date.now() >= nextPrune) {
        await retryInbox(() => inbox.prune(), lifecycle.signal);
        nextPrune = Date.now() + 3_600_000;
      }
      const updates = await telegramCall("getUpdates", () => bot.api.getUpdates({
        offset, limit, timeout: 30, allowed_updates: [],
      }, signal), lifecycle.signal);
      // Snapshot before the DB call: a recovered handler can finish while its redelivery is being accepted.
      const fresh = updates.filter(update => !inFlight.has(update.update_id));
      const accepted = await retryInbox(() => inbox.accept(fresh), lifecycle.signal);
      const last = updates.at(-1);
      offsetToConfirm = last ? last.update_id + 1 : undefined;
      offset = offsetToConfirm ?? 0;
      return accepted;
    },
  });
  source.setGeneratorPace(maxActiveChats);
  const pending = new Set<Promise<void>>();
  const pendingByChat = new Map<number | Update, number>();
  let chatSlotAvailable: (() => void) | undefined;
  const sink = createConcurrentSink<Update, unknown>({
    consume(update) {
      // Use the same chat as the sequentialize middleware, including for callbacks.
      inFlight.add(update.update_id);
      const key = new Context(update, bot.api, bot.botInfo).chat?.id ?? update;
      pendingByChat.set(key, (pendingByChat.get(key) ?? 0) + 1);
      const task = bot.handleUpdate(update).catch(async error => {
        if (error instanceof BotError && error.error instanceof PublicInboxError) throw error.error;
        await bot.errorHandler(error);
      });
      pending.add(task);
      return task.finally(() => {
        pending.delete(task);
        inFlight.delete(update.update_id);
        const remaining = pendingByChat.get(key)! - 1;
        if (remaining) {
          pendingByChat.set(key, remaining);
        } else {
          pendingByChat.delete(key);
          chatSlotAvailable?.();
        }
      });
    },
  }, async error => {
    // A failed receipt write must be recovered before taking more work.
    pollingError = error;
    void stopRunner();
  }, { concurrency: maxPendingUpdates });
  const runner = createRunner(source, {
    ...sink,
    async handle(updates) {
      const bufferSpace = await sink.handle(updates);
      while (pendingByChat.size >= maxActiveChats) {
        await new Promise<void>(resolve => { chatSlotAvailable = resolve; });
        chatSlotAvailable = undefined;
      }
      // Every update in the next poll could belong to a different chat.
      return Math.min(bufferSpace, maxActiveChats - pendingByChat.size);
    },
  });
  let stopping = false;
  let running: Promise<void> | undefined;
  let pollingError: unknown;

  function stopRunner() {
    lifecycle.abort();
    if (runner.isRunning()) return runner.stop();
  }

  async function poll() {
    try {
      const signal = telegramSignal(lifecycle.signal);
      await telegramCall("getMe", () => bot.init(signal), lifecycle.signal);
      await telegramCall("deleteWebhook", () => bot.api.deleteWebhook({}, signal), lifecycle.signal);
      inbox = publicInbox(bot.botInfo.id);
      recovered = await retryInbox(() => inbox.recover(), lifecycle.signal);
    } catch (error) {
      if (stopping) return;
      throw error;
    }
    if (stopping) return;
    runner.start();
    try {
      await runner.task();
    } finally {
      // Stopping the update fetcher can finish while a page is still being sent.
      await Promise.allSettled(pending);
    }
    if (pollingError) throw pollingError;
    if (stopping && offsetToConfirm !== undefined) {
      const offset = offsetToConfirm;
      const shutdownSignal = AbortSignal.timeout(2000);
      // The inbox also suppresses redelivery if Telegram is down during shutdown.
      await telegramCall("getUpdates", () => bot.api.getUpdates({ offset, limit: 1, timeout: 0 }, telegramSignal(shutdownSignal)), shutdownSignal)
        .catch(() => undefined);
    }
  }

  return {
    start() { return running ??= poll(); },
    async stop() {
      stopping = true;
      await stopRunner();
      await running;
    },
  };
}
