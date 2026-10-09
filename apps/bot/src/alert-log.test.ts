import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyBotError, logBotAlert } from "./alert-log.js";

afterEach(() => vi.restoreAllMocks());

describe("bot alert logging", () => {
  it("describes Telegram rate limits", () => {
    expect(classifyBotError({ error_code: 429, description: "Too Many Requests" })).toEqual({
      code: "rate_limit",
      reason: "Telegram ограничил частоту запросов",
    });
  });

  it("writes one structured alert line", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    logBotAlert({ scope: "public-bot", error: { error_code: 403, description: "Forbidden" }, details: { update_id: 42 } });

    expect(JSON.parse(String(errorSpy.mock.calls[0]?.[0]))).toMatchObject({
      alert_code: "telegram_bot_error",
      alert_title: "Ошибка Telegram-бота",
      alert_reason: "Telegram запретил боту доступ к чату или пользователю",
      alert_context: "scope=public-bot",
      error_code: "access_denied",
    });
  });
});
