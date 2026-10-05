import { isMediaPageUrl, mediaTypeFromUrl } from "@dawgostan/core";

const POSTIMAGE_CANDIDATE_URL = /https?:\/\/i\.postimg\.cc\/[^"' <>\]]+/gi;

export function extractPostimageDirectImageUrl(html: string, pageUrl: URL): URL | null {
  const url = extractMediaPageUrls(html, pageUrl)[0];
  return url && mediaTypeFromUrl(url.toString()) === "image" ? url : null;
}

export function extractMediaPageUrls(html: string, pageUrl: URL): URL[] {
  if (pageUrl.hostname === "eblo.id" || pageUrl.hostname === "www.eblo.id") {
    const albumUrls = [...html.matchAll(/<img\b[^>]*>/gi)]
      .filter((tag) => htmlAttribute(tag[0], "class")?.toLowerCase().split(/\s+/).includes("album-media"))
      .map((tag) => directMediaUrl(htmlAttribute(tag[0], "src"), pageUrl, "image"))
      .filter((url): url is URL => Boolean(url));
    if (albumUrls.length > 0) return uniqueUrls(albumUrls);

    for (const tag of html.matchAll(/<img\b[^>]*>/gi)) {
      if (htmlAttribute(tag[0], "id") !== "preview-image") continue;
      const url = directMediaUrl(htmlAttribute(tag[0], "src"), pageUrl, "image");
      if (url) return [url];
    }

    for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
      if (htmlAttribute(tag[0], "property")?.toLowerCase() !== "og:video") continue;
      const url = directMediaUrl(htmlAttribute(tag[0], "content"), pageUrl, "video");
      if (url) return [url];
    }

    for (const tag of html.matchAll(/<[^>]+\bid\s*=\s*["']preview-video["'][^>]*>/gi)) {
      const url = directMediaUrl(htmlAttribute(tag[0], "data-src"), pageUrl, "video");
      if (url) return [url];
    }
    return [];
  }

  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const property = htmlAttribute(tag[0], "property") ?? htmlAttribute(tag[0], "name");
    if (!property || !["og:image", "twitter:image"].includes(property.toLowerCase())) continue;
    const url = directMediaUrl(htmlAttribute(tag[0], "content"), pageUrl, "image");
    if (url) return [url];
  }

  for (const tag of html.matchAll(/<(?:input|a)\b[^>]*>/gi)) {
    const id = htmlAttribute(tag[0], "id")?.toLowerCase();
    if (id !== "direct" && id !== "download") continue;
    const url = directMediaUrl(htmlAttribute(tag[0], id === "direct" ? "value" : "href"), pageUrl, "image");
    if (url) return [url];
  }

  for (const match of html.matchAll(POSTIMAGE_CANDIDATE_URL)) {
    const url = directMediaUrl(match[0], pageUrl, "image");
    if (url) return [url];
  }

  return [];
}

export function isResolvableMediaPageUrl(rawUrl: string): boolean {
  return isMediaPageUrl(rawUrl);
}

function directMediaUrl(value: string | null | undefined, pageUrl: URL, expectedType: "image" | "video"): URL | null {
  if (!value) return null;

  try {
    const url = new URL(decodeHtml(value), pageUrl);
    return mediaTypeFromUrl(url.toString()) === expectedType ? url : null;
  } catch {
    return null;
  }
}

function htmlAttribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match?.[2] ?? match?.[3] ?? match?.[4] ?? null;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function uniqueUrls(urls: URL[]): URL[] {
  return [...new Map(urls.map((url) => [url.toString(), url])).values()];
}
