import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyOperationalError, logServiceAlert } from "./alert-log.js";

afterEach(() => vi.restoreAllMocks());

describe("operational alert logging", () => {
  it("classifies a nested DNS failure", () => {
    const error = new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo EAI_AGAIN profiles-service.w.tv"), { code: "EAI_AGAIN" }) });

    expect(classifyOperationalError(error)).toEqual({
      code: "dns",
      reason: "DNS не смог найти адрес внешнего сервиса",
    });
  });

  it("classifies common media failures", () => {
    expect(classifyOperationalError(new Error("Sign in to confirm your age"))).toEqual({
      code: "youtube_auth",
      reason: "YouTube требует вход или подтверждение возраста",
    });
    expect(classifyOperationalError(new Error("ffmpeg exited with code 1"))).toEqual({
      code: "media_processing",
      reason: "Не удалось обработать медиа через ffmpeg",
    });
  });

  it.each([
    ["request timed out after 30s", "timeout"],
    ["GET failed with 404", "not_found"],
    ["HTTP 429 Too Many Requests", "rate_limit"],
    ["Prisma P1001 database unavailable", "database"],
    ["Telegram Bad Request", "telegram"],
    ["upstream returned 503", "upstream"],
  ])("classifies %s", (message, code) => {
    expect(classifyOperationalError(new Error(message)).code).toBe(code);
  });

  it("writes one JSON line with stable alert fields", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    logServiceAlert({
      code: "wtv_poll_failed",
      title: "WTV недоступен",
      component: "wtv",
      context: "channel=mishamedvedka",
      error: Object.assign(new Error("getaddrinfo EAI_AGAIN profiles-service.w.tv"), { code: "EAI_AGAIN" }),
    });

    expect(errorSpy).toHaveBeenCalledOnce();
    expect(JSON.parse(String(errorSpy.mock.calls[0]?.[0]))).toMatchObject({
      alert_code: "wtv_poll_failed",
      alert_title: "WTV недоступен",
      alert_reason: "DNS не смог найти адрес внешнего сервиса",
      alert_severity: "warning",
      alert_component: "wtv",
      alert_context: "channel=mishamedvedka",
      error_code: "dns",
    });
  });
});
