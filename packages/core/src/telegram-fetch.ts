import fetch, { Response, type RequestInfo, type RequestInit } from "node-fetch";

// grammY parses the body as JSON before exposing the HTTP status. Gateways can
// send plain text for a rejection, so retain the status without logging the body.
export const telegramFetch = Object.assign(async (url: RequestInfo, init?: RequestInit): Promise<Response> => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const detach = () => init?.signal?.removeEventListener("abort", abort);
  if (init?.signal?.aborted) abort();
  else init?.signal?.addEventListener("abort", abort);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (response.status !== 429 && (response.status < 500 || response.status >= 600)) {
      response.body.once("close", detach);
      return response;
    }
    let retryAfter: number | undefined;
    if (response.status === 429) {
      const header = response.headers.get("retry-after");
      if (header) {
        const seconds = /^\d+$/.test(header) ? Number(header) : Math.ceil((Date.parse(header) - Date.now()) / 1000);
        if (Number.isFinite(seconds)) retryAfter = Math.max(1, seconds);
      }
      const contentType = response.headers.get("content-type");
      if (retryAfter === undefined && (!contentType || contentType.includes("json"))) {
        const body = await response.json().catch(() => null);
        const seconds = body?.parameters?.retry_after;
        if (Number.isSafeInteger(seconds) && seconds > 0) retryAfter = seconds;
      }
    }
    // The status is authoritative even when the gateway never finishes its body.
    abort();
    detach();
    return new Response(JSON.stringify({ ok: false, error_code: response.status,
      description: response.status === 429 ? "Telegram rate limit" : "Telegram service unavailable",
      ...(retryAfter ? { parameters: { retry_after: retryAfter } } : {}),
    }));
  } catch (error) {
    detach();
    throw error;
  }
}, fetch);
