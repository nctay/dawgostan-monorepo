import { getExtension, IMAGE_EXTENSIONS, maxBytesForMediaType, VIDEO_EXTENSIONS } from "@dawgostan/core";

const apiBase = "https://cloud-api.yandex.net/v1/disk/public/resources";
const allowedMimes: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
};

type PublicResource = { type?: string; name?: string; mime_type?: string; size?: number };

export async function resolveYandexDiskMediaUrl(publicUrl: URL, imageLimit: number, videoLimit: number): Promise<URL> {
  const canonicalUrl = new URL(`https://disk.yandex.ru${publicUrl.pathname.replace(/\/$/, "")}`);
  const metadata = await getApiJson<PublicResource>(canonicalUrl, "");
  if (metadata.type !== "file") throw new Error("Yandex Disk resource is not a file");

  const extension = getExtension(`/${metadata.name ?? ""}`);
  const mediaType = extension && IMAGE_EXTENSIONS.has(extension) ? "image" : extension && VIDEO_EXTENSIONS.has(extension) ? "video" : "other";
  const mimeType = metadata.mime_type?.toLowerCase();
  if (mediaType === "other" || (mimeType && mimeType !== "application/octet-stream" && mimeType !== allowedMimes[extension ?? ""])) {
    throw new Error("Yandex Disk file has unsupported media type");
  }

  const limit = maxBytesForMediaType(mediaType, imageLimit, videoLimit);
  if (!Number.isSafeInteger(metadata.size) || !metadata.size || metadata.size < 0) throw new Error("Yandex Disk file size is unavailable");
  if (metadata.size > limit) throw new Error(`Yandex Disk file is too large: ${metadata.size} > ${limit}`);

  const download = await getApiJson<{ href?: string }>(canonicalUrl, "/download");
  const directUrl = download.href ? new URL(download.href) : null;
  if (directUrl?.protocol !== "https:" || directUrl.hostname !== "downloader.disk.yandex.ru") {
    throw new Error("Yandex Disk returned an unexpected download URL");
  }
  return directUrl;
}

async function getApiJson<T>(publicUrl: URL, suffix: string): Promise<T> {
  const apiUrl = new URL(`${apiBase}${suffix}`);
  apiUrl.searchParams.set("public_key", publicUrl.toString());
  const response = await fetch(apiUrl, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Yandex Disk API failed with ${response.status}`);
  return response.json() as Promise<T>;
}
