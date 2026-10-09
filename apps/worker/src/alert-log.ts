export type AlertSeverity = "warning" | "critical";

type ServiceAlert = {
  code: string;
  title: string;
  component: string;
  error: unknown;
  severity?: AlertSeverity;
  context?: string;
  details?: Record<string, string | number | boolean | null | undefined>;
};

export function logServiceAlert(alert: ServiceAlert): void {
  const classified = classifyOperationalError(alert.error);
  console.error(
    JSON.stringify({
      alert_code: alert.code,
      alert_title: alert.title,
      alert_reason: classified.reason,
      alert_severity: alert.severity ?? "warning",
      alert_component: alert.component,
      ...(alert.context ? { alert_context: alert.context } : {}),
      error_code: classified.code,
      error_message: operationalErrorText(alert.error).slice(0, 2_000),
      ...(alert.details ? { details: alert.details } : {}),
    }),
  );
}

export function classifyOperationalError(error: unknown): { code: string; reason: string } {
  const text = operationalErrorText(error);

  if (/EAI_AGAIN|ENOTFOUND|getaddrinfo/i.test(text)) return { code: "dns", reason: "DNS не смог найти адрес внешнего сервиса" };
  if (/ETIMEDOUT|timed? out|timeout|AbortError/i.test(text)) return { code: "timeout", reason: "Внешний сервис не ответил вовремя" };
  if (/ECONNREFUSED/i.test(text)) return { code: "connection_refused", reason: "Внешний сервис отклонил соединение" };
  if (/ECONNRESET|fetch failed|socket hang up|network error/i.test(text)) return { code: "network", reason: "Соединение с внешним сервисом оборвалось" };
  if (/sign in to confirm|confirm your age|age.restrict|not a bot|cookies?/i.test(text)) {
    return { code: "youtube_auth", reason: "YouTube требует вход или подтверждение возраста" };
  }
  if (/video unavailable|private video|has been removed|media page direct media not found/i.test(text)) {
    return { code: "media_unavailable", reason: "Медиа удалено, закрыто или больше недоступно" };
  }
  if (/\b429\b|too many requests|rate.?limit/i.test(text)) return { code: "rate_limit", reason: "Внешний сервис ограничил частоту запросов" };
  if (/\b(?:401|403)\b|unauthori[sz]ed|forbidden|access denied/i.test(text)) return { code: "access_denied", reason: "Внешний сервис отказал в доступе" };
  if (/\b404\b|not found/i.test(text)) return { code: "not_found", reason: "Файл или страница больше не найдены" };
  if (/ffmpeg|ffprobe|transcod|convert/i.test(text)) return { code: "media_processing", reason: "Не удалось обработать медиа через ffmpeg" };
  if (/too large|exceeded (?:byte|upload|size) limit|too long|daily download limit/i.test(text)) {
    return { code: "media_limit", reason: "Медиа превышает допустимый размер или длительность" };
  }
  if (/telegram|grammy|bad request/i.test(text)) return { code: "telegram", reason: "Telegram API отклонил запрос" };
  if (/prisma|postgres|database|\bP\d{4}\b/i.test(text)) return { code: "database", reason: "Ошибка обращения к PostgreSQL" };
  if (/JSON|unexpected token|invalid response/i.test(text)) return { code: "invalid_response", reason: "Внешний сервис вернул некорректный ответ" };
  if (/\b5\d\d\b|service unavailable|bad gateway|gateway timeout/i.test(text)) {
    return { code: "upstream", reason: "Внешний сервис временно недоступен" };
  }

  return { code: "unknown", reason: "Неизвестная ошибка — подробности сохранены в логах" };
}

export function operationalErrorText(error: unknown): string {
  const parts: string[] = [];
  collectErrorParts(error, parts, new Set<object>(), 0);
  return parts.join(" | ") || String(error);
}

function collectErrorParts(value: unknown, parts: string[], seen: Set<object>, depth: number): void {
  if (depth > 4 || value == null) return;
  if (typeof value === "string" || typeof value === "number") {
    parts.push(String(value));
    return;
  }
  if (typeof value !== "object" || seen.has(value)) return;
  seen.add(value);

  const record = value as Record<string, unknown>;
  for (const key of ["name", "message", "description", "code", "error_code"]) {
    const field = record[key];
    if ((typeof field === "string" || typeof field === "number") && !parts.includes(String(field))) parts.push(String(field));
  }
  collectErrorParts(record.cause, parts, seen, depth + 1);
  collectErrorParts(record.error, parts, seen, depth + 1);
}
