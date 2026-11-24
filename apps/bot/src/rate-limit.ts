import { setTimeout as delay } from "node:timers/promises";
import { GrammyError, HttpError, type Bot } from "grammy";
import { logBotAlert } from "./alert-log.js";

export { telegramFetch as publicTelegramFetch } from "@dawgostan/core/telegram-fetch";

export class ChatRateLimiter {
  private readonly cooldowns = new Map<number, Promise<void>>();

  constructor(private readonly intervalMs: number, private readonly signal: AbortSignal) {}

  async waitForTurn(chatId: number): Promise<void> {
    await this.cooldowns.get(chatId);
  }

  schedule<T>(chatId: number, task: () => Promise<T>): Promise<T> {
    return withTelegramRetry(() => this.send(chatId, task), this.signal);
  }

  private async send<T>(chatId: number, task: () => Promise<T>): Promise<T> {
    const previous = this.cooldowns.get(chatId);
    let release!: () => void;
    const cooldown = new Promise<void>(resolve => { release = resolve; });
    this.cooldowns.set(chatId, cooldown);
    await previous;
    const nextSendAt = Date.now() + this.intervalMs;
    const unlock = () => {
      if (this.cooldowns.get(chatId) === cooldown) this.cooldowns.delete(chatId);
      release();
    };
    try {
      return await task();
    } finally {
      const remaining = nextSendAt - Date.now();
      if (remaining > 0) setTimeout(unlock, remaining);
      else unlock();
    }
  }
}

export function canRetryTelegramSend(error: unknown): boolean {
  if (error instanceof GrammyError) {
    return error.error_code === 429 || (error.error_code >= 500 && error.error_code < 600);
  }
  // DNS failures precede delivery. A reset or timeout can follow acceptance.
  if (!(error instanceof HttpError)) return false;
  const code = (error.error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOTFOUND" || code === "EAI_AGAIN";
}

async function withTelegramRetry<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let wait = 1000; ; wait = Math.min(30_000, wait * 2)) {
    try {
      return await task();
    } catch (error) {
      if (!canRetryTelegramSend(error)) throw error;
      const retryAfter = error instanceof GrammyError ? error.parameters.retry_after : undefined;
      await delay(retryAfter ? retryAfter * 1000 : wait, undefined, { signal });
      signal.throwIfAborted();
    }
  }
}

// grammY on Node uses the older abort-controller declaration for the same signal API.
export function telegramSignal(signal: AbortSignal) {
  return signal as unknown as NonNullable<Parameters<Bot["init"]>[0]>;
}

// Never log or rethrow transport errors. Their nested cause can contain the bot token.
export async function telegramCall<T>(method: string, call: () => Promise<T>, signal: AbortSignal) {
  for (let wait = 100; ; wait = Math.min(30_000, wait * 2)) {
    signal.throwIfAborted();
    try {
      return await call();
    } catch (error) {
      signal.throwIfAborted();
      const status = error instanceof GrammyError ? error.error_code : undefined;
      const message = `Telegram ${method} failed${status ? ` (HTTP ${status})` : ""}`;
      logBotAlert({ scope: method, error: { message, error_code: status } });
      if (!(error instanceof HttpError) && status !== 429 && !(status && status >= 500)) throw new Error(message);
      const retryAfter = error instanceof GrammyError ? error.parameters.retry_after : undefined;
      await delay(retryAfter ? retryAfter * 1000 : wait, undefined, { signal });
    }
  }
}
