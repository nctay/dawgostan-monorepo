import dns from "node:dns/promises";
import { assertSafeResolvedAddress, assertSafeUrl, extractUrls, isSupportedMediaUrl, mediaTypeFromUrl, toUrl } from "@dawgostan/core";
import { env } from "../env.js";
import { logServiceAlert } from "../alert-log.js";

const shortLinkHosts = new Set(["clck.su", "www.clck.su", "bit.ly", "www.bit.ly", "tinyurl.com", "www.tinyurl.com", "clck.ru", "www.clck.ru"]);

const directMediaMimeTypes = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/avif",
  "video/mp4", "video/webm", "video/quicktime",
]);

export class TemporaryShortLinkError extends Error {}

export function isSupportedMediaCandidateUrl(rawUrl: string): boolean {
  return isSupportedMediaUrl(rawUrl) || isShortLinkUrl(rawUrl);
}

export type RedirectProgress = { targetUrl: string; visitedUrls: string[] };

export async function resolveSupportedMediaUrl(rawUrl: string, signal?: AbortSignal): Promise<string | null> {
  signal?.throwIfAborted();
  if (!isShortLinkUrl(rawUrl)) return isSupportedMediaUrl(rawUrl) ? rawUrl : null;
  return resolveShortLink(rawUrl, signal);
}

export function isShortLinkUrl(rawUrl: string): boolean {
  const url = toUrl(rawUrl);
  return Boolean(url && shortLinkHosts.has(url.hostname.toLowerCase()));
}

// Nonempty visitedUrls means the observed target still needs validation.
export async function resolveShortLink(
  sourceUrl: string, signal?: AbortSignal, saved?: RedirectProgress | null,
  persist?: (previous: RedirectProgress | null, next: RedirectProgress) => Promise<RedirectProgress>,
): Promise<string | null> {
  let progress = saved ?? null;
  while (true) {
    signal?.throwIfAborted();
    if (progress && !progress.visitedUrls.length) {
      if (progress !== saved) console.log(`[resolver] short-link url=${sourceUrl} resolved=${progress.targetUrl}`);
      return progress.targetUrl;
    }
    const visited = progress?.visitedUrls ?? [];
    const url = progress ? new URL(progress.targetUrl) : toUrl(sourceUrl);
    if (!url || visited.includes(url.href) || visited.length > 4) return null;
    const timeout = AbortSignal.timeout(15_000);
    const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let next: RedirectProgress | null;
    try {
      next = await readRedirectHop(url, visited, deadline, Boolean(persist));
    } catch (error) {
      signal?.throwIfAborted();
      logServiceAlert({
        code: "short_link_resolution_failed",
        title: "Не удалось раскрыть короткую ссылку",
        component: "url-resolver",
        context: `host=${toUrl(sourceUrl)?.hostname ?? "unknown"}`,
        error,
        details: { url: sourceUrl },
      });
      if (error instanceof TemporaryShortLinkError) throw error;
      return null;
    }
    if (!next) return null;
    // Record Location before the next DNS check. Concurrent readers follow the winning observation.
    progress = persist ? await persist(progress, next) : next;
  }
}

async function readRedirectHop(url: URL, visited: string[], signal: AbortSignal, canRetry: boolean): Promise<RedirectProgress | null> {
  const short = isShortLinkUrl(url.href);
  const supported = !short && isSupportedMediaUrl(url.href);

  // A file-shaped hop can lead to a CDN URL with no extension.
  const fileRedirect = !supported && !short && visited.some(hop => mediaTypeFromUrl(hop) !== "other");
  async function request(method: "HEAD" | "GET", range = false) {
    await assertSafeNetworkTarget(url, signal);
    signal.throwIfAborted();
    return fetch(url, {
      method, redirect: "manual", signal,
      headers: {
        accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        ...(range ? { range: "bytes=0-0" } : {}),
        "user-agent": "Mozilla/5.0 (compatible; chat-meme-scraper/1.0)",
      },
    }).catch(temporaryNetworkFailure);
  }
  let response = fileRedirect ? await request("HEAD") : await request("GET", supported);
  if (fileRedirect && !isRedirect(response.status) && !(response.ok && directMediaMimeTypes.has(responseMime(response)))) {
    // Some CDNs disable HEAD. A one-byte GET can still confirm the MIME without downloading the file.
    void response.body?.cancel().catch(() => undefined);
    response = await request("GET", true);
  }
  let mime = responseMime(response);
  if (fileRedirect && !directMediaMimeTypes.has(mime) &&
      ((response.status === 206 && isRedirectDocument(mime)) || response.status === 416)) {
    // A partial HTML response may have cut off the redirect. Read the whole document.
    void response.body?.cancel().catch(() => undefined);
    response = await request("GET");
    mime = responseMime(response);
  }
  const media = !short && response.ok && directMediaMimeTypes.has(mime);
  if (isRedirect(response.status) || supported || media || !response.ok || !isRedirectDocument(mime)) {
    void response.body?.cancel().catch(() => undefined);
  }
  const temporaryFailure = response.status === 408 || response.status === 429 || response.status >= 500;
  // w.tv can resume from this Location. A transient response hasn't confirmed its final destination.
  if (temporaryFailure && (canRetry || !supported)) throw new TemporaryShortLinkError(`Short link failed with ${response.status}`);
  let target: URL | null;
  if (isRedirect(response.status)) {
    target = redirectUrl(url, response);
  } else if (supported || media) {
    // Only the headers are needed to distinguish a real file from another redirect.
    // The download job handles unavailable file servers and reads the actual media body.
    return { targetUrl: url.href, visitedUrls: [] };
  } else {
    if (!response.ok) throw new Error(`Short link failed with ${response.status}`);
    if (!isRedirectDocument(mime)) return null;
    target = extractHtmlRedirectUrl(await response.text().catch(temporaryNetworkFailure), url);
  }
  if (!target || visited.length >= 4 || target.href === url.href || visited.includes(target.href)) return null;
  return { targetUrl: target.href, visitedUrls: [...visited, url.href] };
}

function responseMime(response: Response): string {
  return response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
}

function isRedirectDocument(mime: string): boolean {
  return !mime || mime === "text/plain" || mime === "text/html" || mime === "application/xhtml+xml";
}

function extractHtmlRedirectUrl(html: string, baseUrl: URL): URL | null {
  const patterns = [
    /\b(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i,
    /\b(?:window\.)?location\.(?:assign|replace)\(\s*["']([^"']+)["']\s*\)/i,
    /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"']+)["']/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    const target = match?.[1]?.trim();
    if (target) return new URL(decodeHtmlAttribute(target), baseUrl);
  }

  for (const candidate of extractUrls(html)) {
    const url = toUrl(decodeHtmlAttribute(candidate));
    if (url && isSupportedMediaUrl(url.toString())) return url;
  }

  return null;
}

function decodeHtmlAttribute(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&#x2F;/gi, "/").replace(/&#47;/g, "/").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function temporaryNetworkFailure(cause: unknown): never {
  throw new TemporaryShortLinkError("Short link request temporarily failed", { cause });
}

async function assertSafeNetworkTarget(url: URL, signal: AbortSignal): Promise<void> {
  assertSafeUrl(url);
  if (env.ALLOW_PRIVATE_MEDIA_HOSTS) return;
  signal.throwIfAborted();
  // getaddrinfo cannot be interrupted. Stop waiting when the poll ends and never fetch its late result.
  const addresses = await new Promise<{ address: string }[]>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    dns.lookup(url.hostname, { all: true, verbatim: true }).then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  }).catch(temporaryNetworkFailure);
  if (!addresses.length) throw new TemporaryShortLinkError("Short link host has no address");
  for (const address of addresses) assertSafeResolvedAddress(address.address);
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

function redirectUrl(base: URL, response: Response): URL {
  const location = response.headers.get("location");
  if (!location) throw new Error("Redirect without location");
  return new URL(location, base);
}
