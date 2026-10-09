type BotAlertInput = {
  scope: string;
  error: unknown;
  code?: string;
  title?: string;
  severity?: "warning" | "action";
  details?: Record<string, string | number | null | undefined>;
};

export function logBotAlert(input: BotAlertInput): void {
  const classified = classifyBotError(input.error);
  console.error(
    JSON.stringify({
      alert_code: input.code ?? "telegram_bot_error",
      alert_title: input.title ?? "Ошибка Telegram-бота",
      alert_reason: classified.reason,
      alert_severity: input.severity ?? (classified.code === "access_denied" ? "action" : "warning"),
      alert_component: "telegram",
      alert_context: `scope=${input.scope}`,
      error_code: classified.code,
      error_message: botErrorText(input.error).slice(0, 2_000),
      ...(input.details ? { details: input.details } : {}),
    }),
  );
}

export function classifyBotError(error: unknown): { code: string; reason: string } {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const status = Number(record.error_code);
  const text = botErrorText(error);
  const networkCode = String(record.code ?? (record.error as Record<string, unknown> | undefined)?.code ?? "");

  if (status === 429) return { code: "rate_limit", reason: "Telegram ограничил частоту запросов" };
  if (status === 403) return { code: "access_denied", reason: "Telegram запретил боту доступ к чату или пользователю" };
  if (status === 400) return { code: "bad_request", reason: "Telegram отклонил данные запроса" };
  if (/EAI_AGAIN|ENOTFOUND/.test(networkCode) || /getaddrinfo/i.test(text)) return { code: "dns", reason: "DNS не смог найти адрес Telegram" };
  if (/ETIMEDOUT|ECONNRESET|fetch failed/i.test(`${networkCode} ${text}`)) {
    return { code: "network", reason: "Соединение с Telegram временно прервалось" };
  }
  return { code: "telegram", reason: "Telegram API вернул ошибку" };
}

function botErrorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const fields = [record.name, record.message, record.description, record.code, record.error_code].filter(
      (value): value is string | number => typeof value === "string" || typeof value === "number",
    );
    return fields.map(String).join(" | ") || "Unknown Telegram error";
  }
  return String(error);
}
