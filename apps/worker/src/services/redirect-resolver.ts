import dns from "node:dns/promises";
import { assertSafeResolvedAddress, assertSafeUrl, extractUrls, isSupportedMediaUrl, toUrl } from "@dawgostan/core";
import { env } from "../env.js";

const shortLinkHosts = new Set(["clck.su", "www.clck.su", "bit.ly", "www.bit.ly", "tinyurl.com", "www.tinyurl.com", "clck.ru", "www.clck.ru"]);

export function isSupportedMediaCandidateUrl(rawUrl: string): boolean {
  return isSupportedMediaUrl(rawUrl) || isShortLinkUrl(rawUrl);
}

export async function resolveSupportedMediaUrl(rawUrl: string): Promise<string | null> {
  if (isSupportedMediaUrl(rawUrl)) return rawUrl;
  if (!isShortLinkUrl(rawUrl)) return null;

  try {
    const resolved = await resolveShortLink(rawUrl);
    if (!resolved || !isSupportedMediaUrl(resolved.toString())) return null;
    console.log(`[resolver] short-link url=${rawUrl} resolved=${resolved.toString()}`);
    return resolved.toString();
  } catch (error) {
    console.warn(`[resolver] short-link failed url=${rawUrl}`, error);
    return null;
  }
}

function isShortLinkUrl(rawUrl: string): boolean {
  const url = toUrl(rawUrl);
  return Boolean(url && shortLinkHosts.has(url.hostname.toLowerCase()));
}

async function resolveShortLink(rawUrl: string): Promise<URL | null> {
  let url = toUrl(rawUrl);
  if (!url) return null;
  const visited = new Set<string>();

  for (let redirects = 0; redirects <= 4; redirects += 1) {
    if (visited.has(url.toString())) return null;
    visited.add(url.toString());
    await assertSafeNetworkTarget(url);
    const response = await fetch(url, {
      redirect: "manual",
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "Mozilla/5.0 (compatible; chat-meme-scraper/1.0)",
      },
    });

    if (isRedirect(response.status)) {
      url = redirectUrl(url, response);
      continue;
    }
    if (!response.ok) throw new Error(`Short link failed with ${response.status}`);
    if (isSupportedMediaUrl(url.toString())) return url;

    return extractHtmlRedirectUrl(await response.text(), url);
  }

  return null;
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

async function assertSafeNetworkTarget(url: URL): Promise<void> {
  assertSafeUrl(url);
  if (env.ALLOW_PRIVATE_MEDIA_HOSTS) return;
  const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
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
