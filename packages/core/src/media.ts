export type MediaType = "image" | "video" | "other";

export const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif"]);
export const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov"]);
export const ALLOWED_MEDIA_HOSTS = new Set([
  "media.discordapp.net",
  "cdn.discordapp.com",
  "images-ext-1.discordapp.net",
  "i.ibb.co",
]);
export const PLATFORM_MEDIA_HOSTS = new Set(["www.tiktok.com", "tiktok.com", "vm.tiktok.com", "vt.tiktok.com", "www.youtube.com", "youtube.com", "m.youtube.com", "youtu.be"]);
export const MEDIA_PAGE_HOSTS = new Set(["postimg.cc", "www.postimg.cc", "ibb.co", "www.ibb.co", "eblo.id", "www.eblo.id", "disk.yandex.ru", "yadi.sk"]);

export const DEFAULT_MAX_IMAGE_BYTES = 30 * 1024 * 1024;
export const DEFAULT_MAX_VIDEO_BYTES = 100 * 1024 * 1024;

const URL_PATTERN =
  /\b(?:(?:https?:\/\/|www\.)[^\s<>"'`]+|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"'`]*)?)/gi;
const TRAILING_PUNCTUATION = /[),.;:!?]+$/;

export function extractUrls(text: string): string[] {
  return [...(text.match(URL_PATTERN) ?? [])]
    .map((url) => url.replace(TRAILING_PUNCTUATION, ""))
    .filter(Boolean);
}

export function toUrl(rawUrl: string): URL | null {
  try {
    const withScheme = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    const url = new URL(withScheme);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return url;
  } catch {
    return null;
  }
}

export function normalizeUrl(rawUrl: string): string | null {
  const url = toUrl(rawUrl);
  if (!url) return null;

  url.hash = "";
  url.hostname = url.hostname.toLowerCase();

  const twitchClipId = getTwitchClipId(url);
  if (twitchClipId) return `https://clips.twitch.tv/${twitchClipId}`;
  if (isYandexDiskUrl(url.toString())) return `https://disk.yandex.ru${url.pathname.replace(/\/$/, "")}`;

  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }

  if (ALLOWED_MEDIA_HOSTS.has(url.hostname)) {
    const keep = new URLSearchParams();
    for (const key of ["format", "quality", "width", "height"]) {
      const value = url.searchParams.get(key);
      if (value) keep.set(key, value);
    }
    url.search = keep.toString();
  }

  return url.toString();
}

export function getExtension(urlOrPath: string): string | null {
  const path = urlOrPath.startsWith("/") ? urlOrPath : (toUrl(urlOrPath)?.pathname ?? urlOrPath);
  const match = path.toLowerCase().match(/\.([a-z0-9]{2,5})$/);
  return match?.[1] ?? null;
}

export function mediaTypeFromUrl(rawUrl: string): MediaType {
  const url = toUrl(rawUrl);
  if (!url) return "other";
  if (["disk.yandex.ru", "yadi.sk"].includes(url.hostname.toLowerCase())) return "other";
  const ext = getExtension(url.pathname);
  if (ext && IMAGE_EXTENSIONS.has(ext)) return "image";
  if (ext && VIDEO_EXTENSIONS.has(ext)) return "video";
  if (ALLOWED_MEDIA_HOSTS.has(url.hostname.toLowerCase())) return "image";
  return "other";
}

export function isSupportedMediaUrl(rawUrl: string): boolean {
  return mediaTypeFromUrl(rawUrl) !== "other" || isPlatformMediaUrl(rawUrl) || isMediaPageUrl(rawUrl);
}

export function isMediaPageUrl(rawUrl: string): boolean {
  const url = toUrl(rawUrl);
  if (!url) return false;
  const hostname = url.hostname.toLowerCase();
  if (!MEDIA_PAGE_HOSTS.has(hostname)) return false;
  if (hostname === "disk.yandex.ru" || hostname === "yadi.sk") return isYandexDiskUrl(rawUrl);
  const segments = url.pathname.split("/").filter(Boolean);
  if (hostname === "eblo.id" || hostname === "www.eblo.id") return segments.length === 1 && /^[A-Za-z0-9]{7}$/.test(segments[0] ?? "");
  return segments.length === 1 && segments[0] !== "gallery";
}

export function isYandexDiskUrl(rawUrl: string): boolean {
  const url = toUrl(rawUrl);
  return Boolean(url && url.protocol === "https:" && ["disk.yandex.ru", "yadi.sk"].includes(url.hostname.toLowerCase()) && /^\/(?:i|d)\/[A-Za-z0-9_-]+\/?$/.test(url.pathname));
}

export function isPlatformMediaUrl(rawUrl: string): boolean {
  const url = toUrl(rawUrl);
  if (!url) return false;
  if (getTwitchClipId(url)) return true;
  const hostname = url.hostname.toLowerCase();
  if (!PLATFORM_MEDIA_HOSTS.has(hostname)) return false;

  if (hostname === "youtu.be") return url.pathname.length > 1;
  if (hostname.endsWith("youtube.com")) return url.pathname.startsWith("/shorts/") || (url.pathname === "/watch" && Boolean(url.searchParams.get("v")));
  if (["vm.tiktok.com", "vt.tiktok.com"].includes(hostname)) return url.pathname.length > 1;
  if (["tiktok.com", "www.tiktok.com"].includes(hostname)) return /^\/(?:@[^/]+\/video\/\d+|t\/[^/]+)\/?$/.test(url.pathname);
  return false;
}

function getTwitchClipId(url: URL): string | null {
  if (url.hostname === "clips.twitch.tv") {
    return url.pathname.match(/^\/([A-Za-z0-9_-]+)\/?$/)?.[1] ?? null;
  }
  if (["twitch.tv", "www.twitch.tv", "m.twitch.tv"].includes(url.hostname)) {
    return url.pathname.match(/^\/[A-Za-z0-9_]+\/clip\/([A-Za-z0-9_-]+)\/?$/)?.[1] ?? null;
  }
  return null;
}

export function mediaTypeFromContentType(contentType: string | null | undefined): MediaType {
  const clean = contentType?.split(";")[0]?.trim().toLowerCase();
  if (!clean) return "other";
  if (clean.startsWith("image/")) return "image";
  if (clean.startsWith("video/")) return "video";
  return "other";
}

export function isAnimatedWebp(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  if (!matchesAscii(bytes, 0, "RIFF") || !matchesAscii(bytes, 8, "WEBP")) return false;

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkSize = readUint32LE(bytes, offset + 4);
    if (matchesAscii(bytes, offset, "ANIM") || matchesAscii(bytes, offset, "ANMF")) return true;
    offset += 8 + chunkSize + (chunkSize % 2);
  }

  return false;
}

export function maxBytesForMediaType(type: MediaType, imageLimit = DEFAULT_MAX_IMAGE_BYTES, videoLimit = DEFAULT_MAX_VIDEO_BYTES): number {
  if (type === "image") return imageLimit;
  if (type === "video") return videoLimit;
  return 0;
}

function matchesAscii(bytes: Uint8Array, offset: number, value: string): boolean {
  if (offset + value.length > bytes.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (byteAt(bytes, offset) | (byteAt(bytes, offset + 1) << 8) | (byteAt(bytes, offset + 2) << 16) | (byteAt(bytes, offset + 3) << 24)) >>> 0;
}

function byteAt(bytes: Uint8Array, offset: number): number {
  return bytes[offset] ?? 0;
}
