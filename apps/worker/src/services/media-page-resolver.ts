import { isMediaPageUrl, mediaTypeFromUrl } from "@dawgostan/core";

const POSTIMAGE_CANDIDATE_URL = /https?:\/\/i\.postimg\.cc\/[^"' <>\]]+/gi;

export function extractPostimageDirectImageUrl(html: string, pageUrl: URL): URL | null {
  if (pageUrl.hostname === "eblo.id" || pageUrl.hostname === "www.eblo.id") {
    for (const tag of html.matchAll(/<img\b[^>]*>/gi)) {
      if (htmlAttribute(tag[0], "id") !== "preview-image") continue;
      const url = directImageUrl(htmlAttribute(tag[0], "src"), pageUrl);
      if (url) return url;
    }
    return null;
  }

  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const property = htmlAttribute(tag[0], "property") ?? htmlAttribute(tag[0], "name");
    if (!property || !["og:image", "twitter:image"].includes(property.toLowerCase())) continue;
    const url = directImageUrl(htmlAttribute(tag[0], "content"), pageUrl);
    if (url) return url;
  }

  for (const tag of html.matchAll(/<(?:input|a)\b[^>]*>/gi)) {
    const id = htmlAttribute(tag[0], "id")?.toLowerCase();
    if (id !== "direct" && id !== "download") continue;
    const url = directImageUrl(htmlAttribute(tag[0], id === "direct" ? "value" : "href"), pageUrl);
    if (url) return url;
  }

  for (const match of html.matchAll(POSTIMAGE_CANDIDATE_URL)) {
    const url = directImageUrl(match[0], pageUrl);
    if (url) return url;
  }

  return null;
}

export function isResolvableMediaPageUrl(rawUrl: string): boolean {
  return isMediaPageUrl(rawUrl);
}

function directImageUrl(value: string | null | undefined, pageUrl: URL): URL | null {
  if (!value) return null;

  try {
    const url = new URL(decodeHtml(value), pageUrl);
    return mediaTypeFromUrl(url.toString()) === "image" ? url : null;
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
