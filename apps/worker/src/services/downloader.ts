import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import type { Asset } from "@prisma/client";
import { Bot, GrammyError, HttpError, InputFile } from "grammy";
import { failDownload, markBlocked, markStoredReferences } from "./download-references.js";
import { assertSafeResolvedAddress, assertSafeUrl, getExtension, isAnimatedWebp, isPlatformMediaUrl, isYandexDiskUrl, maxBytesForMediaType, mediaTypeFromContentType, mediaTypeFromUrl, normalizeUrl, toUrl } from "@dawgostan/core";
import { convertAnimatedWebpToMp4, normalizePhotoForTelegram, transcodeForTelegram } from "@dawgostan/media-processing";
import { prisma } from "../prisma.js";
import { env } from "../env.js";
import { assertPlatformMetadataFits, PlatformDownloadRejectedError, platformFormatSelector, type PlatformMetadata } from "./platform-download.js";
import { publishStoredTelegramMedia, readVideoCodec, readVideoMetadata, storeTelegramMedia, storeTelegramMediaGroup, telegramMediaGroupMaxItems, type VideoMetadata } from "./telegram-storage.js";
import { extractImgurAlbumUrls, extractMediaPageUrls, isResolvableMediaPageUrl } from "./media-page-resolver.js";
import { classifyNsfw } from "./nsfw.js";
import { resolveYandexDiskMediaUrl } from "./yandex-disk.js";
import { logServiceAlert, operationalErrorText, redactTelegramTokens } from "../alert-log.js";
import { SerialRateLimiter } from "./rate-limit.js";
import { replaceChannelPost, sendConverterMedia, type ConverterMedia } from "./converter-channel.js";

type DownloadResult = {
  filePath: string;
  sha256: string;
  byteSize: number;
  mimeType: string;
  mediaType: "image" | "video";
  finalUrl: string;
  telegramSendAsAnimation?: boolean;
  videoMetadata?: VideoMetadata;
};

const shaLocks = new Map<string, Promise<void>>();
const activeDownloadSlots = new Set<Promise<void>>();
const youtubeCookiesFile = "/run/private/youtube-cookies.txt";
const telegramVideoMaxBytes = 49_900_000;
const converterBot = env.TELEGRAM_CONVERTER_BOT_TOKEN ? new Bot(env.TELEGRAM_CONVERTER_BOT_TOKEN) : null;
const converterBotKey = env.TELEGRAM_CONVERTER_BOT_TOKEN ? crypto.createHash("sha256").update(env.TELEGRAM_CONVERTER_BOT_TOKEN).digest("hex") : null;
const converterSendLimiter = new SerialRateLimiter(1100);
const converterUsernames = new Set((env.TELEGRAM_CONVERTER_ALLOWED_USERNAMES ?? "").split(",").map((name) => name.trim().replace(/^@/, "").toLowerCase()).filter(Boolean));
const converterUncertainMessage = "Результат отправки неизвестен. Проверь сообщения: автоматически повторять отправку не буду.";
const converterRecovery = new Map<string, { status: "pending" | "failed" | "uncertain"; lastError?: string; chatId?: string }>();
let converterRecoveryTask: Promise<void> | null = null;

class MediaDownloadRejectedError extends Error {
  constructor(message: string, readonly mediaType?: "image" | "video") {
    super(message);
  }
}

export async function recoverInterruptedDownloadJobs(): Promise<void> {
  // Storage is committed before references. A confirmed receipt is enough to
  // finish that transition, including delivery intent, without uploading again.
  const stored = await prisma.downloadJob.findMany({
    where: { status: "running", chatPost: { status: { in: ["pending", "failed"] } },
      asset: { is: { status: "stored", telegramChatId: { not: null }, telegramMessageId: { not: null } } } },
    select: { id: true, assetId: true, chatPostId: true, chatPost: { select: { normalizedUrl: true } } },
  });
  for (const job of stored) {
    await markStoredReferences(job.assetId!, job.chatPost.normalizedUrl, job.id, job.chatPostId, job.assetId, true);
  }
  const recovered = await prisma.downloadJob.updateMany({
    where: {
      status: "running",
      // shortcut: jobs older than seven days need manual replay; add paced recovery if outages last longer.
      updatedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000) },
      asset: {
        is: {
          status: { in: ["pending", "failed"] },
          sha256: null,
          telegramMessageId: null,
          telegramMessageIds: { isEmpty: true },
          telegramFileId: null,
          telegramFileIds: { isEmpty: true },
          publicTelegramMessageId: null,
        },
      },
    },
    data: { status: "pending", nextRetryAt: null },
  });
  if (recovered.count) console.log(`[download] recovered interrupted jobs=${recovered.count}`);
  if (converterBot) {
    await prisma.conversionRequest.updateMany({ where: { status: "downloading" }, data: { status: "pending" } });
    const interrupted = await prisma.conversionRequest.findMany({ where: { status: { in: ["storing", "delivering"] } }, include: { owner: true } });
    for (const request of interrupted) {
      await prisma.conversionRequest.update({ where: { id: request.id }, data: { status: "uncertain", lastError: converterUncertainMessage } });
      if (request.owner && converterUsernames.has(request.owner.username)) {
        await converterSendLimiter.schedule(() => converterBot.api.sendMessage(String(request.chatId), converterUncertainMessage)).catch(() => undefined);
      }
    }
  }
}

export function processDownloadQueue(): void {
  const slots = Math.max(1, env.MAX_PARALLEL_DOWNLOADS);
  while (activeDownloadSlots.size < slots) {
    const task = (async () => {
      while (true) {
        const archived = await processOneJob();
        const converted = await processOneConversionRequest();
        if (!archived && !converted) break;
      }
    })();
    activeDownloadSlots.add(task);
    void task
      .catch((error) =>
        logServiceAlert({ code: "download_queue_failed", title: "Очередь загрузок остановилась", component: "downloader", severity: "critical", error }),
      )
      .finally(() => activeDownloadSlots.delete(task));
  }
}

export async function waitForDownloadQueue(): Promise<void> {
  await Promise.allSettled(activeDownloadSlots);
}

async function processOneJob(): Promise<boolean> {
  const job = await claimDownloadJob();
  if (!job) return false;
  console.log(`[download] started job=${job.id} asset=${job.assetId ?? "none"} url=${job.url}`);

  try {
    const normalizedUrl = normalizeUrl(job.url);
    if (!normalizedUrl) throw new Error("Invalid URL");

    const blockedByUrl = await prisma.blockedMedia.findUnique({ where: { normalizedUrl } });
    if (blockedByUrl) {
      await markBlocked(job.id, job.chatPostId, normalizedUrl, "URL is blocked");
      return true;
    }

    const existingByUrl = await prisma.asset.findUnique({ where: { normalizedUrl } });
    const finishStorage = async (asset: Asset) => {
      await markStoredReferences(asset.id, normalizedUrl, job.id, job.chatPostId, existingByUrl?.id ?? job.assetId);
      const sourceId = job.chatPost.rawTwitchMessageId ?? job.chatPost.twitchMessageId;
      if (!sourceId?.startsWith("wtv:")) await publishStoredTelegramMedia(asset, publicMetadata(job));
    };
    const existingStoredAsset = existingByUrl?.status === "stored" ? existingByUrl : await findStoredAssetForNormalizedUrl(normalizedUrl);
    if (existingStoredAsset) {
      await finishStorage(existingStoredAsset);
      console.log(`[download] reused-stored job=${job.id} asset=${existingStoredAsset.id}`);
      return true;
    }

    await assertDailyLimitAvailable();
    const downloads = await downloadMedia(job.url);
    try {
      const downloaded = downloads[0]!;
      const sha256 = downloads.length === 1 ? downloaded.sha256 : crypto.createHash("sha256").update(downloads.map((item) => item.sha256).join("\n")).digest("hex");
      const sha256s = downloads.map((item) => item.sha256);
      const byteSize = downloads.reduce((total, item) => total + item.byteSize, 0);

      await withShaLock(sha256, async () => {
        let blockedByHash = null;
        for (const hash of new Set([sha256, ...downloads.map((item) => item.sha256)])) {
          blockedByHash = await prisma.blockedMedia.findUnique({ where: { sha256: hash } });
          if (blockedByHash) break;
        }
        if (blockedByHash) {
          await markBlocked(job.id, job.chatPostId, normalizedUrl, "SHA-256 is blocked");
          return;
        }

        const existingByHash = await prisma.asset.findUnique({ where: { sha256 } });
        if (existingByHash?.status === "stored") {
          await finishStorage(existingByHash);
          return;
        }

        const assetId = existingByUrl?.id ?? crypto.randomUUID();
        let publicSpoiler = false;
        for (const [index, item] of downloads.entries()) {
          const moderation = await classifyNsfw(
            item.filePath,
            item.mediaType,
            item.mediaType === "video" || item.mimeType === "image/gif" || Boolean(item.telegramSendAsAnimation),
          );
          console.log(
            `[nsfw] asset=${assetId} item=${index + 1}/${downloads.length} status=${moderation.status} owen=${moderation.owenScore?.toFixed(4) ?? "none"} siglip=${moderation.siglipScore?.toFixed(4) ?? "none"} public_spoiler=${moderation.publicSpoiler}`,
          );
          if (moderation.publicSpoiler) {
            publicSpoiler = true;
            break;
          }
        }
        const storageMetadata = {
          originalUrl: job.url,
          normalizedUrl,
          sha256,
          streamerLogin: job.chatPost.streamSession.streamer.login,
          streamerDisplayName: job.chatPost.streamSession.streamer.displayName,
          streamStartedAt: job.chatPost.streamSession.startedAt,
          streamSessionId: job.chatPost.streamSession.id,
          assetId,
          authorName: job.chatPost.authorName,
          messageText: job.chatPost.messageText,
          skipTelegramPublic: job.chatPost.skipTelegramPublic,
          telegramSendAsAnimation: downloaded.telegramSendAsAnimation,
        };
        const stored =
          downloads.length === 1
            ? await storeTelegramMedia(downloaded.filePath, downloaded.mimeType, downloaded.mediaType, { ...storageMetadata, videoMetadata: downloaded.videoMetadata })
            : await storeTelegramMediaGroup(downloads, storageMetadata);

        const asset = await prisma.asset.upsert({
          where: { normalizedUrl },
          create: {
            id: assetId,
            originalUrl: job.url,
            normalizedUrl,
            sha256,
            sha256s,
            storageProvider: stored.storageProvider,
            telegramChatId: stored.telegramChatId,
            telegramMessageId: stored.telegramMessageId,
            telegramMessageIds: stored.telegramMessageIds,
            telegramFileId: stored.telegramFileId,
            telegramFileIds: stored.telegramFileIds,
            telegramMediaTypes: stored.telegramMediaTypes,
            telegramFileUniqueId: stored.telegramFileUniqueId,
            publicTelegramChatId: null,
            publicTelegramMessageId: null,
            publicHasSpoiler: publicSpoiler,
            telegramIsAnimation: downloads.length === 1 && (Boolean(downloaded.telegramSendAsAnimation) || downloaded.mimeType === "image/gif"),
            mimeType: downloaded.mimeType,
            byteSize,
            mediaType: downloaded.mediaType,
            status: "stored",
            visibility: "public",
          },
          update: {
            sha256,
            sha256s,
            storageProvider: stored.storageProvider,
            telegramChatId: stored.telegramChatId,
            telegramMessageId: stored.telegramMessageId,
            telegramMessageIds: stored.telegramMessageIds,
            telegramFileId: stored.telegramFileId,
            telegramFileIds: stored.telegramFileIds,
            telegramMediaTypes: stored.telegramMediaTypes,
            telegramFileUniqueId: stored.telegramFileUniqueId,
            publicHasSpoiler: publicSpoiler,
            telegramIsAnimation: downloads.length === 1 && (Boolean(downloaded.telegramSendAsAnimation) || downloaded.mimeType === "image/gif"),
            mimeType: downloaded.mimeType,
            byteSize,
            mediaType: downloaded.mediaType,
            status: "stored",
            visibility: "public",
          },
        });

        await finishStorage(asset);
        console.log(`[download] stored job=${job.id} asset=${asset.id} items=${downloads.length} bytes=${byteSize} mime=${downloaded.mimeType}`);
      });
    } finally {
      await Promise.all(downloads.map((item) => fs.promises.rm(item.filePath, { force: true }).catch(() => undefined)));
    }
  } catch (error) {
    const message = error instanceof HttpError
      ? operationalErrorText(error)
      : redactTelegramTokens(error instanceof Error ? error.message : String(error));
    const currentAttempts = job.attempts;
    const rejected = error instanceof PlatformDownloadRejectedError || error instanceof MediaDownloadRejectedError;
    const retry = !rejected && currentAttempts < 3;
    if (retry) {
      await prisma.downloadJob.update({
        where: { id: job.id }, data: { status: "pending", lastError: message, nextRetryAt: new Date(Date.now() + 60_000 * currentAttempts) },
      });
    } else {
      await failDownload(job.id, job.chatPostId, job.chatPost.normalizedUrl, job.assetId, message);
    }
    const log = `[download] ${rejected ? "rejected" : "failed"} job=${job.id} asset=${job.assetId ?? "none"} attempts=${currentAttempts} retry=${retry} error=${message}`;
    if (rejected) console.info(log);
    else if (retry) console.warn(log);
    else {
      logServiceAlert({
        code: "download_failed",
        title: "Не удалось скачать медиа",
        component: "downloader",
        context: `platform=${mediaSource(job.url)}`,
        error,
        details: {
          job_id: job.id,
          asset_id: job.assetId,
          url: job.url,
          attempts: currentAttempts,
          streamer: job.chatPost.streamSession.streamer.login,
        },
      });
    }
  }
  return true;
}

function mediaSource(rawUrl: string): string {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host.includes("youtube.com") || host === "youtu.be") return "youtube";
    if (host.includes("tiktok.com")) return "tiktok";
    if (host.includes("twitch.tv")) return "twitch";
    if (host === "postimg.cc" || host === "ibb.co" || host === "eblo.id") return "image-host";
    if (host.endsWith("yandex.ru") || host === "yadi.sk") return "yandex-disk";
    if (host.endsWith("discordapp.com") || host.endsWith("discordapp.net")) return "discord";
    return "direct";
  } catch {
    return "unknown";
  }
}

function publicMetadata(job: NonNullable<Awaited<ReturnType<typeof claimDownloadJob>>>) {
  return {
    streamerLogin: job.chatPost.streamSession.streamer.login,
    streamStartedAt: job.chatPost.streamSession.startedAt,
    authorName: job.chatPost.authorName,
    messageText: job.chatPost.messageText,
    skipTelegramPublic: job.chatPost.skipTelegramPublic,
  };
}

async function claimDownloadJob() {
  const claimed = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE "download_jobs"
    SET "status" = 'running',
        "attempts" = "attempts" + 1,
        "updatedAt" = NOW()
    WHERE "id" = (
      SELECT "id"
      FROM "download_jobs"
      WHERE "status" = 'pending'
        AND ("nextRetryAt" IS NULL OR "nextRetryAt" <= NOW())
        AND NOT EXISTS (
          SELECT 1
          FROM "download_jobs" AS running
          WHERE running."assetId" IS NOT DISTINCT FROM "download_jobs"."assetId"
            AND running."status" = 'running'
        )
      ORDER BY "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING "id"
  `;
  const id = claimed[0]?.id;
  if (!id) return null;
  return prisma.downloadJob.findUnique({
    where: { id },
    include: { chatPost: { include: { streamSession: { include: { streamer: true } } } } },
  });
}

async function findStoredAssetForNormalizedUrl(normalizedUrl: string) {
  const post = await prisma.chatPost.findFirst({
    where: {
      normalizedUrl,
      status: "stored",
      asset: { status: "stored" },
    },
    orderBy: { postedAt: "asc" },
    include: { asset: true },
  });
  return post?.asset ?? null;
}

async function withShaLock<T>(sha256: string, task: () => Promise<T>): Promise<T> {
  const previous = shaLocks.get(sha256) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = previous.catch(() => undefined).then(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  shaLocks.set(sha256, current);
  await previous.catch(() => undefined);

  try {
    return await task();
  } finally {
    release();
    if (shaLocks.get(sha256) === current) shaLocks.delete(sha256);
  }
}

async function downloadMedia(rawUrl: string, allowYouTubeCookies = true): Promise<DownloadResult[]> {
  const initialUrl = toUrl(rawUrl);
  if (!initialUrl) throw new Error("Invalid media URL");
  // A queued file URL can start redirecting to a page between ingestion and download.
  const source = await openMediaUrl(initialUrl, true);
  if (source.response) return [await readDirectMedia(source.url, source.response)];
  let platformUrl = source.url;
  if (["vm.tiktok.com", "vt.tiktok.com"].includes(platformUrl.hostname.toLowerCase())) {
    platformUrl = await resolveTikTokShortUrl(platformUrl, source.redirects);
  }
  if (isPlatformMediaUrl(platformUrl.toString()) && !/^\/@[^/]+\/photo\/\d+\/?$/.test(platformUrl.pathname)) {
    return [await downloadPlatformVideo(platformUrl.toString(), allowYouTubeCookies)];
  }
  const pageUrl = platformUrl;
  const urls = await resolveMediaPageUrls(pageUrl, source.redirects);
  const maxItems = (["tiktok.com", "www.tiktok.com"].includes(pageUrl.hostname.toLowerCase()) && pageUrl.pathname.includes("/photo/"))
    || ["imgur.com", "www.imgur.com"].includes(pageUrl.hostname.toLowerCase()) ? 35 : telegramMediaGroupMaxItems;
  if (urls.length > maxItems) {
    throw new MediaDownloadRejectedError(`Media album has too many items: ${urls.length} > ${maxItems}`);
  }
  const downloads: DownloadResult[] = [];
  let totalBytes = 0;
  const aggregateLimit = Math.min(env.MAX_VIDEO_BYTES, env.MAX_IMAGE_BYTES * telegramMediaGroupMaxItems);
  try {
    for (const url of urls) {
      let downloaded: DownloadResult;
      try {
        const file = await openMediaUrl(url, false);
        downloaded = await readDirectMedia(file.url, file.response);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const videoUrl = mediaTypeFromUrl(url.toString()) === "video" || getExtension(url.pathname) === "gif";
        const unsuitableVideo = (error instanceof MediaDownloadRejectedError && (error.mediaType === "video" || videoUrl))
          || (message.startsWith("ffmpeg failed:") && videoUrl);
        if (urls.length > 1 && unsuitableVideo) {
          console.info(`[download] skipped album video url=${redactTelegramTokens(url.toString())} reason=${redactTelegramTokens(message).slice(0, 200)}`);
          continue;
        }
        throw error;
      }
      if (urls.length > 1 && downloaded.mediaType === "video") {
        downloaded.videoMetadata = await readVideoMetadata(downloaded.filePath, false);
        const { duration, width, height } = downloaded.videoMetadata;
        const reason = !duration || !width || !height ? "video metadata unavailable" : duration > env.MAX_PLATFORM_VIDEO_SECONDS
          ? `video is too long: ${duration}s > ${env.MAX_PLATFORM_VIDEO_SECONDS}s` : null;
        if (reason) {
          console.info(`[download] skipped album video url=${url.toString()} reason=${reason}`);
          await fs.promises.rm(downloaded.filePath, { force: true });
          continue;
        }
      }
      if (urls.length > 1 && totalBytes + downloaded.byteSize > aggregateLimit) {
        if (downloaded.mediaType === "video") {
          console.info(`[download] skipped album video url=${url.toString()} reason=album byte limit`);
          await fs.promises.rm(downloaded.filePath, { force: true });
          continue;
        }
        for (let index = downloads.length - 1; index >= 0 && totalBytes + downloaded.byteSize > aggregateLimit; index--) {
          if (downloads[index]!.mediaType !== "video") continue;
          const video = downloads.splice(index, 1)[0]!;
          totalBytes -= video.byteSize;
          console.info(`[download] skipped album video url=${video.finalUrl} reason=album byte limit`);
          await fs.promises.rm(video.filePath, { force: true });
        }
      }
      if (urls.length > 1 && totalBytes + downloaded.byteSize > aggregateLimit) {
        await fs.promises.rm(downloaded.filePath, { force: true });
        throw new MediaDownloadRejectedError(`Media album is too large: ${totalBytes + downloaded.byteSize} > ${aggregateLimit}`);
      }
      downloads.push(downloaded);
      totalBytes += downloaded.byteSize;
    }
    if (downloads.length === 0) throw new MediaDownloadRejectedError("Media album has no suitable items");
    return downloads;
  } catch (error) {
    await Promise.all(downloads.map((item) => fs.promises.rm(item.filePath, { force: true }).catch(() => undefined)));
    throw error;
  }
}

type MediaResponse = { url: URL; response: Response; redirects: number };
type MediaPage = { url: URL; response: null; redirects: number };

function openMediaUrl(url: URL, dispatchPages: false): Promise<MediaResponse>;
function openMediaUrl(url: URL, dispatchPages: true): Promise<MediaResponse | MediaPage>;
async function openMediaUrl(url: URL, dispatchPages: boolean): Promise<MediaResponse | MediaPage> {
  for (let redirects = 0; redirects <= 4; redirects++) {
    await assertSafeNetworkTarget(url);
    if (dispatchPages && (isResolvableMediaPageUrl(url.href) || isPlatformMediaUrl(url.href))) {
      return { url, response: null, redirects };
    }
    const response = await fetch(url, { redirect: "manual" });
    if (!isRedirect(response.status)) return { url, response, redirects };
    void response.body?.cancel().catch(() => undefined);
    url = redirectUrl(url, response);
  }
  throw new Error("Too many redirects");
}

async function readDirectMedia(url: URL, get: Response): Promise<DownloadResult> {
  if (!get.ok || !get.body) throw new Error(`GET failed with ${get.status}`);

  const urlMediaType = mediaTypeFromUrl(url.toString());
  const contentMediaType = mediaTypeFromContentType(get.headers.get("content-type"));
  const mediaType = contentMediaType !== "other" ? contentMediaType : urlMediaType;
  if (mediaType === "other") throw new Error("URL does not point to supported media");

  const limit = maxBytesForMediaType(mediaType, env.MAX_IMAGE_BYTES, env.MAX_VIDEO_BYTES);
  const contentLength = Number(get.headers.get("content-length") ?? "0");
  if (contentLength > limit) {
    await get.body.cancel();
    throw new MediaDownloadRejectedError(`Media is too large: ${contentLength} > ${limit}`, mediaType);
  }

  const mimeType = get.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
  const actualMediaType = mediaTypeFromContentType(mimeType);
  const finalMediaType = actualMediaType !== "other" ? actualMediaType : mediaType;
  if (finalMediaType !== "image" && finalMediaType !== "video") throw new Error(`Unsupported content type: ${mimeType}`);

  const tempPath = path.join(os.tmpdir(), `archive-media-${crypto.randomUUID()}`);
  let byteSize = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      byteSize += chunk.length;
      if (byteSize > limit) callback(new MediaDownloadRejectedError(`Media exceeded byte limit ${limit}`, mediaType));
      else callback(null, chunk);
    },
  });

  try {
    await pipeline(Readable.fromWeb(get.body as Parameters<typeof Readable.fromWeb>[0]), limiter, fs.createWriteStream(tempPath));
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return finalizeDownload(tempPath, finalMediaType, url.toString(), limit, mimeType);
}

async function resolveMediaPageUrls(url: URL, redirectsUsed: number): Promise<URL[]> {
  if (["tiktok.com", "www.tiktok.com"].includes(url.hostname.toLowerCase()) && /^\/@[^/]+\/photo\/\d+\/?$/.test(url.pathname)) {
    if (!env.ENABLE_PLATFORM_DOWNLOADS) throw new Error("Platform downloads are disabled");
    return extractTikTokPhotoUrls(url);
  }
  if (isYandexDiskUrl(url.toString())) {
    const directUrl = await resolveYandexDiskMediaUrl(url, env.MAX_IMAGE_BYTES, env.MAX_VIDEO_BYTES);
    await assertSafeNetworkTarget(directUrl);
    return [directUrl];
  }
  if (!isResolvableMediaPageUrl(url.toString())) return [url];
  if (["imgur.com", "www.imgur.com"].includes(url.hostname.toLowerCase())) {
    const albumId = url.pathname.split("/").filter(Boolean)[1]!.split("-").at(-1)!;
    const apiUrl = new URL(`https://imgur.com/ajaxalbums/getimages/${albumId}/hit.json`);
    await assertSafeNetworkTarget(apiUrl);
    const response = await fetch(apiUrl.toString(), { redirect: "manual", headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`Imgur album failed with ${response.status}`);
    const mediaUrls = extractImgurAlbumUrls(await response.json());
    if (mediaUrls.length === 0) throw new Error("Imgur album images not found");
    for (const mediaUrl of mediaUrls) await assertSafeNetworkTarget(mediaUrl);
    console.log(`[resolver] media page=${url.toString()} items=${mediaUrls.length}`);
    return mediaUrls;
  }

  let pageUrl = url;
  for (let redirects = redirectsUsed; redirects <= 4; redirects += 1) {
    await assertSafeNetworkTarget(pageUrl);
    const response = await fetch(pageUrl, {
      redirect: "manual",
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    if (isRedirect(response.status)) {
      pageUrl = redirectUrl(pageUrl, response);
      continue;
    }
    if (!response.ok) throw new Error(`Media page failed with ${response.status}`);

    const mediaUrls = extractMediaPageUrls(await response.text(), pageUrl);
    if (mediaUrls.length === 0) throw new Error("Media page direct media not found");
    for (const mediaUrl of mediaUrls) await assertSafeNetworkTarget(mediaUrl);
    console.log(`[resolver] media page=${url.toString()} items=${mediaUrls.length}`);
    return mediaUrls;
  }

  throw new Error("Too many media page redirects");
}

async function resolveTikTokShortUrl(initialUrl: URL, redirectsUsed: number): Promise<URL> {
  let url = initialUrl;
  for (let redirects = redirectsUsed; redirects <= 4; redirects += 1) {
    await assertSafeNetworkTarget(url);
    const response = await fetch(url, { method: "HEAD", redirect: "manual", headers: { "user-agent": "facebookexternalhit/1.1" } });
    if (!isRedirect(response.status)) throw new Error(`TikTok short link failed with ${response.status}`);
    if (redirects === 4) break;
    url = redirectUrl(url, response);
    if (!isPlatformMediaUrl(url.toString())) throw new Error("TikTok short link resolved to unsupported URL");
    if (["tiktok.com", "www.tiktok.com"].includes(url.hostname.toLowerCase()) && /^\/@[^/]+\/(?:photo|video)\/\d+\/?$/.test(url.pathname)) {
      url.search = "";
      url.hash = "";
      return url;
    }
  }
  throw new Error("Too many TikTok redirects");
}

async function extractTikTokPhotoUrls(url: URL): Promise<URL[]> {
  await assertSafeNetworkTarget(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.PLATFORM_DOWNLOAD_TIMEOUT_MS);
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn("gallery-dl", ["--config-ignore", "-g", "-o", "extractor.tiktok.audio=false", url.toString()], {
        stdio: ["ignore", "pipe", "pipe"],
        signal: controller.signal,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`gallery-dl failed: ${stderr.trim() || `exit code ${code}`}`)));
    });
    const urls = output.trim().split("\n").filter(Boolean).map((value) => toUrl(value));
    if (urls.length === 0) throw new Error("TikTok photo post has no images (TikTok may have blocked access)");
    if (urls.some((item) => !item)) throw new Error("TikTok photo post returned an invalid image URL");
    return urls as URL[];
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`gallery-dl timed out after ${env.PLATFORM_DOWNLOAD_TIMEOUT_MS}ms`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadPlatformVideo(rawUrl: string, allowYouTubeCookies: boolean): Promise<DownloadResult> {
  if (!env.ENABLE_PLATFORM_DOWNLOADS) throw new Error("Platform downloads are disabled");

  const url = toUrl(rawUrl);
  if (!url) throw new Error("Invalid platform URL");
  assertSafeUrl(url);

  const limit = env.MAX_VIDEO_BYTES;
  const formatSelector = platformFormatSelector(limit);
  console.log(`[platform] metadata url=${url.toString()}`);
  await assertPlatformVideoFits(url.toString(), limit, formatSelector, allowYouTubeCookies);
  console.log(`[platform] downloading url=${url.toString()}`);

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "archive-platform-"));
  const outputTemplate = path.join(tempDir, "%(id)s.%(ext)s");
  const ytDlpArgs = [
    "--no-playlist",
    "--no-progress",
    "--restrict-filenames",
    "--max-filesize",
    String(limit),
    "--match-filter",
    `duration <=? ${env.MAX_PLATFORM_VIDEO_SECONDS}`,
    "--format",
    formatSelector,
    "--merge-output-format",
    "mp4",
    "--output",
    outputTemplate,
    url.toString(),
  ];

  try {
    await runYtDlp(ytDlpArgs, allowYouTubeCookies);

    const downloadedPath = await findDownloadedPlatformFile(tempDir);
    const videoMetadata = await readVideoMetadata(downloadedPath);
    const { duration, width, height } = videoMetadata;
    if (!duration) throw new MediaDownloadRejectedError("Platform video duration unavailable", "video");
    assertPlatformMetadataFits({ duration }, limit, env.MAX_PLATFORM_VIDEO_SECONDS);
    const result = await finalizeDownload(downloadedPath, "video", url.toString(), limit);
    if (result.filePath === downloadedPath && width && height) result.videoMetadata = videoMetadata;
    const retainedPath = await retainPlatformDownload(result.filePath, tempDir);
    console.log(`[platform] downloaded url=${url.toString()} bytes=${result.byteSize} mime=${result.mimeType}`);
    return { ...result, filePath: retainedPath };
  } finally {
    await fs.promises.rm(tempDir, { force: true, recursive: true }).catch(() => undefined);
  }
}

async function retainPlatformDownload(filePath: string, tempDir: string): Promise<string> {
  const relativePath = path.relative(tempDir, filePath);
  const isInsideTempDir = relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);
  if (!isInsideTempDir) return filePath;

  const retainedPath = path.join(os.tmpdir(), `archive-video-${crypto.randomUUID()}${path.extname(filePath) || ".mp4"}`);
  await fs.promises.rename(filePath, retainedPath);
  return retainedPath;
}

async function finalizeDownload(filePath: string, mediaType: "image" | "video", finalUrl: string, limit: number, originalMimeType?: string): Promise<DownloadResult> {
  let finalPath = filePath;
  let finalMediaType = mediaType;
  let finalOriginalMimeType = originalMimeType;
  let telegramSendAsAnimation = false;
  let alreadyProcessedVideo = false;

  try {
    if (finalMediaType === "image" && isGifMime(finalOriginalMimeType)) {
      finalPath = path.join(os.tmpdir(), `archive-animation-${crypto.randomUUID()}.mp4`);
      console.log(`[image] converting gif input=${path.basename(filePath)} output=${path.basename(finalPath)}`);
      await transcodeForTelegram(filePath, finalPath, { timeoutMs: env.PLATFORM_DOWNLOAD_TIMEOUT_MS });
      await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
      finalMediaType = "video";
      finalOriginalMimeType = undefined;
      telegramSendAsAnimation = true;
      alreadyProcessedVideo = true;
    }

    if (finalMediaType === "image" && isWebpMime(finalOriginalMimeType) && (await isAnimatedWebpFile(filePath))) {
      finalPath = path.join(os.tmpdir(), `archive-animation-${crypto.randomUUID()}.mp4`);
      console.log(`[image] converting animated webp input=${path.basename(filePath)} output=${path.basename(finalPath)}`);
      await convertAnimatedWebpToMp4(filePath, finalPath, { timeoutMs: env.PLATFORM_DOWNLOAD_TIMEOUT_MS });
      await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
      finalMediaType = "video";
      finalOriginalMimeType = undefined;
      telegramSendAsAnimation = true;
      alreadyProcessedVideo = true;
    }

    if (finalMediaType === "image") {
      const normalizedPhoto = await normalizePhotoForTelegram(finalPath, finalOriginalMimeType, { timeoutMs: env.PLATFORM_DOWNLOAD_TIMEOUT_MS });
      if (normalizedPhoto.filePath !== finalPath) {
        const inputPath = finalPath;
        finalPath = normalizedPhoto.filePath;
        finalOriginalMimeType = normalizedPhoto.mimeType;
        await fs.promises.rm(inputPath, { force: true }).catch(() => undefined);
      }
    }

    const needsVideoConversion = finalMediaType === "video" && !alreadyProcessedVideo && !(await isTelegramMp4(finalPath, finalOriginalMimeType));
    const needsVideoCompression = finalMediaType === "video" && (await fs.promises.stat(finalPath)).size > telegramVideoMaxBytes;
    if (finalMediaType === "video" && (needsVideoConversion || needsVideoCompression)) {
      const inputPath = finalPath;
      finalPath = path.join(os.tmpdir(), `archive-video-${crypto.randomUUID()}.mp4`);
      console.log(`[video] transcoding input=${path.basename(inputPath)} output=${path.basename(finalPath)} target_bytes=${needsVideoCompression ? telegramVideoMaxBytes : "compatible"}`);
      try {
        await transcodeForTelegram(inputPath, finalPath, {
          targetBytes: needsVideoCompression ? telegramVideoMaxBytes : undefined,
          timeoutMs: env.PLATFORM_DOWNLOAD_TIMEOUT_MS,
        });
      } finally {
        await fs.promises.rm(inputPath, { force: true }).catch(() => undefined);
      }
    }

    const result = await inspectDownloadedFile(finalPath, finalMediaType);
    if (result.byteSize > limit) {
      throw new MediaDownloadRejectedError(`Media exceeded byte limit after processing: ${result.byteSize} > ${limit}`, finalMediaType);
    }
    if (finalMediaType === "video" && result.byteSize > telegramVideoMaxBytes) {
      throw new MediaDownloadRejectedError(`Telegram video exceeded upload limit after processing: ${result.byteSize} > ${telegramVideoMaxBytes}`, "video");
    }

    return {
      ...result,
      mimeType: finalMediaType === "image" && finalOriginalMimeType ? finalOriginalMimeType : result.mimeType,
      filePath: finalPath,
      mediaType: finalMediaType,
      finalUrl,
      telegramSendAsAnimation,
    };
  } catch (error) {
    await fs.promises.rm(finalPath, { force: true }).catch(() => undefined);
    if (finalPath !== filePath) await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function isAnimatedWebpFile(filePath: string): Promise<boolean> {
  return isAnimatedWebp(await fs.promises.readFile(filePath));
}

function isWebpMime(mimeType: string | undefined): boolean {
  return mimeType?.split(";")[0]?.trim().toLowerCase() === "image/webp";
}

function isGifMime(mimeType: string | undefined): boolean {
  return mimeType?.split(";")[0]?.trim().toLowerCase() === "image/gif";
}

async function isTelegramMp4(filePath: string, mimeType: string | undefined): Promise<boolean> {
  if (getExtension(filePath) !== "mp4" && mimeType?.split(";")[0]?.trim().toLowerCase() !== "video/mp4") return false;
  return (await readVideoCodec(filePath)) === "h264";
}

async function assertPlatformVideoFits(url: string, limit: number, formatSelector: string, allowYouTubeCookies: boolean): Promise<void> {
  const metadata = JSON.parse(
    await runYtDlp([
      "--dump-json",
      "--skip-download",
      "--no-playlist",
      "--no-warnings",
      "--no-progress",
      "--format",
      formatSelector,
      url,
    ], allowYouTubeCookies),
  ) as PlatformMetadata;

  assertPlatformMetadataFits(metadata, limit, env.MAX_PLATFORM_VIDEO_SECONDS);
}

async function runYtDlp(args: string[], allowYouTubeCookies: boolean): Promise<string> {
  args = ["--js-runtimes", "node", ...args];
  if (!allowYouTubeCookies) args = ["--ignore-config", ...args];
  const hostname = toUrl(args.at(-1) ?? "")?.hostname.toLowerCase();
  if (allowYouTubeCookies && hostname && (hostname === "youtu.be" || hostname === "youtube.com" || hostname.endsWith(".youtube.com")) && fs.existsSync(youtubeCookiesFile)) {
    args = ["--cookies", youtubeCookiesFile, ...args];
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.PLATFORM_DOWNLOAD_TIMEOUT_MS);

  try {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn("yt-dlp", args, {
        stdio: ["ignore", "pipe", "pipe"],
        signal: controller.signal,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      child.stdout.on("data", (chunk: Buffer) => {
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr.push(chunk);
      });
      child.on("error", reject);
      child.on("close", (code, signal) => {
        const message = Buffer.concat(stderr).toString("utf8").trim();
        if (code === 0) {
          resolve(Buffer.concat(stdout).toString("utf8"));
          return;
        }
        reject(new Error(`yt-dlp failed${signal ? ` (${signal})` : ""}: ${message || `exit code ${code}`}`));
      });
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`yt-dlp timed out after ${env.PLATFORM_DOWNLOAD_TIMEOUT_MS}ms`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function findDownloadedPlatformFile(tempDir: string): Promise<string> {
  const entries = await fs.promises.readdir(tempDir, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && !entry.name.endsWith(".part") && !entry.name.endsWith(".ytdl"))
      .map(async (entry) => {
        const filePath = path.join(tempDir, entry.name);
        const stat = await fs.promises.stat(filePath);
        return { filePath, size: stat.size };
      }),
  );
  const largest = files.sort((a, b) => b.size - a.size)[0];
  if (!largest) throw new Error("yt-dlp did not produce a media file");
  return largest.filePath;
}

async function inspectDownloadedFile(filePath: string, expectedMediaType: "image" | "video"): Promise<Omit<DownloadResult, "filePath" | "mediaType" | "finalUrl">> {
  const stat = await fs.promises.stat(filePath);
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk);
  }

  return {
    sha256: hash.digest("hex"),
    byteSize: stat.size,
    mimeType: mimeTypeFromPath(filePath, expectedMediaType),
  };
}

function mimeTypeFromPath(filePath: string, expectedMediaType: "image" | "video"): string {
  const ext = getExtension(filePath);
  if (ext === "webm") return "video/webm";
  if (ext === "mov") return "video/quicktime";
  if (ext === "mp4" || expectedMediaType === "video") return "video/mp4";
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
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

async function assertDailyLimitAvailable(): Promise<void> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const aggregate = await prisma.asset.aggregate({
    where: { status: "stored", createdAt: { gte: today } },
    _sum: { byteSize: true },
  });
  const conversions = converterBot ? await prisma.conversionRequest.aggregate({ where: { createdAt: { gte: today } }, _sum: { byteSize: true } }) : null;
  const bytes = Number(aggregate._sum.byteSize ?? 0n) + Number(conversions?._sum.byteSize ?? 0n);
  if (bytes >= env.MAX_DAILY_DOWNLOAD_BYTES) throw new Error("Daily download limit reached");
}

async function processOneConversionRequest(): Promise<boolean> {
  if (!converterBot || !env.TELEGRAM_STORAGE_CHAT_ID) return false;
  await flushConverterRecovery();
  const claimed = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE "conversion_requests" SET "status" = 'downloading', "updatedAt" = NOW()
    WHERE "id" = (
      SELECT "id" FROM "conversion_requests" WHERE "status" = 'pending'
      ORDER BY "createdAt" ASC FOR UPDATE SKIP LOCKED LIMIT 1
    ) RETURNING "id"
  `;
  if (!claimed[0]) return false;
  const request = await prisma.conversionRequest.findUnique({ where: { id: claimed[0].id }, include: { owner: true } }).catch(async () => {
    converterRecovery.set(claimed[0]!.id, { status: "pending" });
    await flushConverterRecovery();
    return undefined;
  });
  if (request === undefined) return false;
  if (!request) return true;
  const channelPost = Boolean(request.channelPostKey);
  const chatId = String(request.chatId);
  const allowed = channelPost
    ? chatId === env.TELEGRAM_CONVERTER_TEST_CHANNEL_ID && chatId !== env.TELEGRAM_STORAGE_CHAT_ID
    : request.owner && converterUsernames.has(request.owner.username) && request.chatId === request.ownerId;
  if (!allowed) {
    converterRecovery.set(request.id, { status: "failed", lastError: "Access revoked" });
    await flushConverterRecovery();
    return true;
  }
  let downloads: DownloadResult[] = [];
  let phase: "downloading" | "storing" | "delivering" = "downloading";
  try {
    await assertDailyLimitAvailable();
    downloads = await downloadMedia(request.originalUrl, false);
    const media = downloads[0];
    if (downloads.length !== 1 || !media) throw new MediaDownloadRejectedError("Нужен один медиафайл.");
    const kind = media.telegramSendAsAnimation ? "animation" : media.mediaType === "image" ? "photo" : "video";
    if (!channelPost && kind !== "video") {
      throw new MediaDownloadRejectedError("Картинки и анимации в личном чате пока не поддерживаются.");
    }
    const metadata = kind === "photo" ? {} : media.videoMetadata ?? await readVideoMetadata(media.filePath);
    if (kind !== "photo") {
      if (!metadata.duration || !metadata.width || !metadata.height) throw new MediaDownloadRejectedError("Не удалось определить параметры видео.");
      if (metadata.duration > Math.min(300, env.MAX_PLATFORM_VIDEO_SECONDS)) throw new MediaDownloadRejectedError("Видео должно быть не длиннее 5 минут.");
    }
    const fileId = await withShaLock(`converter:${media.sha256}`, async () => {
      const cached = await prisma.conversionRequest.findFirst({
        where: {
          botKey: converterBotKey, sha256: media.sha256, telegramFileId: { not: null }, storageMessageId: { not: null },
          OR: kind === "video" ? [{ telegramMediaKind: "video" }, { telegramMediaKind: null }] : [{ telegramMediaKind: kind }],
        },
        select: { telegramFileId: true, storageMessageId: true },
      });
      const identity = { sha256: media.sha256, botKey: converterBotKey, byteSize: BigInt(media.byteSize), telegramMediaKind: kind };
      let telegramFileId = cached?.telegramFileId;
      let storageMessageId = cached?.storageMessageId;
      if (!telegramFileId || !storageMessageId) {
        await prisma.conversionRequest.update({ where: { id: request.id, status: "downloading" }, data: { status: "storing", ...identity } });
        phase = "storing";
        const input: ConverterMedia = {
          type: kind, media: new InputFile(media.filePath, kind === "photo" ? `photo.${media.mimeType.split("/")[1] || "jpg"}` : "video.mp4"),
          caption: channelPost ? `converter request=${request.id}` : `converter request=${request.id} owner=${request.ownerId}`, ...metadata,
          ...(kind === "video" ? { supports_streaming: true } : {}),
        };
        const stored = await converterSendLimiter.schedule(() => sendConverterMedia(converterBot.api, env.TELEGRAM_STORAGE_CHAT_ID!, input));
        telegramFileId = "photo" in stored ? stored.photo.at(-1)?.file_id
          : "animation" in stored ? stored.animation.file_id : "video" in stored ? stored.video.file_id : undefined;
        if (!telegramFileId) throw new Error("Telegram did not return stored file metadata");
        storageMessageId = stored.message_id;
      }
      await prisma.conversionRequest.update({ where: { id: request.id, status: phase }, data: { status: "delivering", ...identity, telegramFileId, storageMessageId } });
      return telegramFileId;
    });
    phase = "delivering";
    let telegramMessageId: number;
    if (channelPost) {
      const { caption, captionLinkOffset, sourcePostedAt } = request;
      if (caption === null || captionLinkOffset === null || !sourcePostedAt) throw new Error("Missing channel post metadata");
      telegramMessageId = await replaceChannelPost(converterBot.api, converterSendLimiter, chatId, request.sourceMessageId, sourcePostedAt, {
        type: kind, media: fileId, caption,
        caption_entities: [{ type: "text_link", offset: captionLinkOffset, length: "Ссылка".length, url: request.originalUrl }],
        ...(kind === "video" ? { supports_streaming: true } : {}),
      }, (messageId) => prisma.conversionRequest.update({ where: { id: request.id }, data: { telegramMessageId: messageId } }));
    } else {
      const delivered = await converterSendLimiter.schedule(() => converterBot.api.sendVideo(chatId, fileId, {
        supports_streaming: true,
        reply_parameters: { message_id: request.sourceMessageId, allow_sending_without_reply: true },
      }));
      telegramMessageId = delivered.message_id;
    }
    await prisma.conversionRequest.update({ where: { id: request.id }, data: { status: "done", telegramMessageId } });
  } catch (error) {
    const uncertain = phase !== "downloading" && (!(error instanceof GrammyError) || error.error_code >= 500);
    const reason = uncertain ? converterUncertainMessage
      : channelPost && phase === "delivering" && error instanceof GrammyError ? `Telegram отклонил ${error.method}: ${redactTelegramTokens(error.description)}`
      : phase !== "downloading" ? "Telegram отклонил отправку видео. Проверь права бота в приватном хранилище."
      : error instanceof MediaDownloadRejectedError ? redactTelegramTokens(error.message) : "Не удалось скачать видео. Проверь, что ссылка публичная и ролик не длиннее 5 минут.";
    if (channelPost) console.warn(`[converter] channel post ${chatId}/${request.sourceMessageId}: ${reason}`);
    converterRecovery.set(request.id, { status: uncertain ? "uncertain" : "failed", lastError: reason, chatId: channelPost ? undefined : chatId });
    await flushConverterRecovery();
  } finally {
    await Promise.all(downloads.map((item) => fs.promises.rm(item.filePath, { force: true }).catch(() => undefined)));
  }
  return true;
}

function flushConverterRecovery(): Promise<void> {
  if (converterRecoveryTask) return converterRecoveryTask;
  // Serialize recovery across slots; failed writes stay queued until the database returns.
  converterRecoveryTask = (async () => {
    for (const [id, recovery] of converterRecovery) {
      const { chatId, ...data } = recovery;
      await prisma.conversionRequest.update({ where: { id }, data });
      converterRecovery.delete(id);
      if (chatId && recovery.lastError && converterBot) {
        await converterSendLimiter.schedule(() => converterBot.api.sendMessage(chatId, recovery.lastError!)).catch(() => {
          logServiceAlert({ code: "converter_notification_failed", title: "Не удалось уведомить о конвертации", component: "converter", error: new Error("Converter notification failed"), details: { request_id: id } });
        });
      }
    }
  })().finally(() => { converterRecoveryTask = null; });
  return converterRecoveryTask;
}
