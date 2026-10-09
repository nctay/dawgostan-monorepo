import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { assertSafeResolvedAddress, assertSafeUrl, getExtension, isAnimatedWebp, isPlatformMediaUrl, isYandexDiskUrl, maxBytesForMediaType, mediaTypeFromContentType, mediaTypeFromUrl, normalizeUrl, toUrl } from "@dawgostan/core";
import { convertAnimatedWebpToMp4, normalizePhotoForTelegram, transcodeForTelegram } from "@dawgostan/media-processing";
import { prisma } from "../prisma.js";
import { env } from "../env.js";
import { assertPlatformMetadataFits, PlatformDownloadRejectedError, platformFormatSelector, type PlatformMetadata } from "./platform-download.js";
import { publishStoredTelegramMedia, storeTelegramMedia, storeTelegramMediaGroup, telegramMediaGroupMaxItems } from "./telegram-storage.js";
import { extractMediaPageUrls, isResolvableMediaPageUrl } from "./media-page-resolver.js";
import { classifyNsfw } from "./nsfw.js";
import { resolveYandexDiskMediaUrl } from "./yandex-disk.js";
import { logServiceAlert } from "../alert-log.js";

type DownloadResult = {
  filePath: string;
  sha256: string;
  byteSize: number;
  mimeType: string;
  mediaType: "image" | "video";
  finalUrl: string;
  telegramSendAsAnimation?: boolean;
};

const shaLocks = new Map<string, Promise<void>>();
const youtubeCookiesFile = "/run/private/youtube-cookies.txt";
const telegramVideoMaxBytes = 49_900_000;

class MediaDownloadRejectedError extends Error {}

export async function processDownloadQueue(): Promise<void> {
  const slots = Math.max(1, env.MAX_PARALLEL_DOWNLOADS);
  await Promise.all(Array.from({ length: slots }, () => processOneJob()));
}

async function processOneJob(): Promise<void> {
  const job = await claimDownloadJob();
  if (!job) return;
  console.log(`[download] started job=${job.id} asset=${job.assetId ?? "none"} url=${job.url}`);

  try {
    const normalizedUrl = normalizeUrl(job.url);
    if (!normalizedUrl) throw new Error("Invalid URL");

    const blockedByUrl = await prisma.blockedMedia.findUnique({ where: { normalizedUrl } });
    if (blockedByUrl) {
      await markBlocked(job.id, job.chatPostId, "URL is blocked");
      return;
    }

    const existingByUrl = await prisma.asset.findUnique({ where: { normalizedUrl } });
    const existingStoredAsset = existingByUrl?.status === "stored" ? existingByUrl : await findStoredAssetForNormalizedUrl(normalizedUrl);
    if (existingStoredAsset) {
      await markStoredReferences(existingStoredAsset.id, normalizedUrl, job.id, job.chatPostId, existingByUrl?.id ?? job.assetId);
      await publishStoredTelegramMedia(existingStoredAsset, publicMetadata(job));
      console.log(`[download] reused-stored job=${job.id} asset=${existingStoredAsset.id}`);
      return;
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
          await markBlocked(job.id, job.chatPostId, "SHA-256 is blocked");
          return;
        }

        const existingByHash = await prisma.asset.findUnique({ where: { sha256 } });
        if (existingByHash?.status === "stored") {
          await markStoredReferences(existingByHash.id, normalizedUrl, job.id, job.chatPostId, existingByUrl?.id ?? job.assetId);
          await publishStoredTelegramMedia(existingByHash, publicMetadata(job));
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
          publicSpoiler ||= moderation.publicSpoiler;
          console.log(
            `[nsfw] asset=${assetId} item=${index + 1}/${downloads.length} status=${moderation.status} owen=${moderation.owenScore?.toFixed(4) ?? "none"} siglip=${moderation.siglipScore?.toFixed(4) ?? "none"} public_spoiler=${moderation.publicSpoiler}`,
          );
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
            ? await storeTelegramMedia(downloaded.filePath, downloaded.mimeType, downloaded.mediaType, storageMetadata)
            : await storeTelegramMediaGroup(
                downloads.map((item) => ({ filePath: item.filePath, mimeType: item.mimeType })),
                storageMetadata,
              );

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

        await markStoredReferences(asset.id, normalizedUrl, job.id, job.chatPostId);
        await publishStoredTelegramMedia(asset, publicMetadata(job));
        console.log(`[download] stored job=${job.id} asset=${asset.id} items=${downloads.length} bytes=${byteSize} mime=${downloaded.mimeType}`);
      });
    } finally {
      await Promise.all(downloads.map((item) => fs.promises.rm(item.filePath, { force: true }).catch(() => undefined)));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const currentAttempts = job.attempts;
    const rejected = error instanceof PlatformDownloadRejectedError || error instanceof MediaDownloadRejectedError;
    const retry = !rejected && currentAttempts < 3;
    const jobUpdate = prisma.downloadJob.update({
      where: { id: job.id },
      data: {
        status: retry ? "pending" : "failed",
        lastError: message,
        nextRetryAt: retry ? new Date(Date.now() + 60_000 * currentAttempts) : null,
      },
    });
    await (retry
      ? jobUpdate
      : prisma.$transaction([
          jobUpdate,
          prisma.chatPost.updateMany({
            where: {
              status: "pending",
              OR: [{ id: job.chatPostId }, { normalizedUrl: job.chatPost.normalizedUrl }],
            },
            data: { status: "failed" },
          }),
          prisma.asset.updateMany({
            where: { id: job.assetId ?? "", status: "pending" },
            data: { status: "failed" },
          }),
        ]));
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
          attempts: currentAttempts,
          streamer: job.chatPost.streamSession.streamer.login,
        },
      });
    }
  }
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

async function markStoredReferences(assetId: string, normalizedUrl: string, jobId: string, chatPostId: string, staleAssetId?: string | null): Promise<void> {
  const duplicateAssetIds = [assetId, staleAssetId].filter((id): id is string => Boolean(id));

  await prisma.$transaction([
    prisma.chatPost.updateMany({
      where: {
        status: { in: ["pending", "failed"] },
        OR: [{ id: chatPostId }, { assetId: { in: duplicateAssetIds } }, { normalizedUrl }],
      },
      data: {
        assetId,
        status: "stored",
      },
    }),
    prisma.downloadJob.updateMany({
      where: {
        id: { not: jobId },
        assetId: { in: duplicateAssetIds },
        status: { in: ["pending", "failed"] },
      },
      data: {
        assetId,
        status: "done",
        nextRetryAt: null,
        lastError: null,
      },
    }),
    prisma.downloadJob.update({
      where: { id: jobId },
      data: {
        assetId,
        status: "done",
        nextRetryAt: null,
        lastError: null,
      },
    }),
  ]);
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

async function downloadMedia(rawUrl: string): Promise<DownloadResult[]> {
  if (isPlatformMediaUrl(rawUrl)) {
    return [await downloadPlatformVideo(rawUrl)];
  }
  const pageUrl = toUrl(rawUrl);
  if (!pageUrl) throw new Error("Invalid media URL");
  const urls = await resolveMediaPageUrls(pageUrl);
  if (urls.length > telegramMediaGroupMaxItems) {
    throw new MediaDownloadRejectedError(`Media album has too many items: ${urls.length} > ${telegramMediaGroupMaxItems}`);
  }
  const downloads: DownloadResult[] = [];
  let totalBytes = 0;
  const aggregateLimit = Math.min(env.MAX_VIDEO_BYTES, env.MAX_IMAGE_BYTES * telegramMediaGroupMaxItems);
  try {
    for (const url of urls) {
      const downloaded = await downloadDirectMedia(url);
      downloads.push(downloaded);
      if (urls.length > 1 && downloaded.mediaType !== "image") {
        throw new MediaDownloadRejectedError("Media albums may only contain images");
      }
      totalBytes += downloaded.byteSize;
      if (urls.length > 1 && totalBytes > aggregateLimit) {
        throw new MediaDownloadRejectedError(`Media album is too large: ${totalBytes} > ${aggregateLimit}`);
      }
    }
    return downloads;
  } catch (error) {
    await Promise.all(downloads.map((item) => fs.promises.rm(item.filePath, { force: true }).catch(() => undefined)));
    throw error;
  }
}

async function downloadDirectMedia(initialUrl: URL): Promise<DownloadResult> {
  let url = initialUrl;

  for (let redirects = 0; redirects <= 4; redirects += 1) {
    await assertSafeNetworkTarget(url);
    const head = await fetch(url, { method: "HEAD", redirect: "manual" });
    if (isRedirect(head.status)) {
      url = redirectUrl(url, head);
      continue;
    }

    const urlMediaType = mediaTypeFromUrl(url.toString());
    const contentMediaType = mediaTypeFromContentType(head.headers.get("content-type"));
    const mediaType = contentMediaType !== "other" ? contentMediaType : urlMediaType;
    if (mediaType === "other") throw new Error("URL does not point to supported media");

    const limit = maxBytesForMediaType(mediaType, env.MAX_IMAGE_BYTES, env.MAX_VIDEO_BYTES);
    const contentLength = Number(head.headers.get("content-length") ?? "0");
    if (contentLength > limit) throw new Error(`Media is too large: ${contentLength} > ${limit}`);

    const get = await fetch(url, { redirect: "manual" });
    if (isRedirect(get.status)) {
      url = redirectUrl(url, get);
      continue;
    }
    if (!get.ok || !get.body) throw new Error(`GET failed with ${get.status}`);

    const mimeType = get.headers.get("content-type")?.split(";")[0]?.trim() || head.headers.get("content-type") || "application/octet-stream";
    const actualMediaType = mediaTypeFromContentType(mimeType);
    const finalMediaType = actualMediaType !== "other" ? actualMediaType : mediaType;
    if (finalMediaType !== "image" && finalMediaType !== "video") throw new Error(`Unsupported content type: ${mimeType}`);

    const tempPath = path.join(os.tmpdir(), `archive-media-${crypto.randomUUID()}`);
    const hash = crypto.createHash("sha256");
    let byteSize = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        byteSize += chunk.length;
        if (byteSize > limit) callback(new Error(`Media exceeded byte limit ${limit}`));
        else {
          hash.update(chunk);
          callback(null, chunk);
        }
      },
    });

    try {
      await pipeline(Readable.fromWeb(get.body as Parameters<typeof Readable.fromWeb>[0]), limiter, fs.createWriteStream(tempPath));
    } catch (error) {
      await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
    hash.digest("hex");
    return finalizeDownload(tempPath, finalMediaType, url.toString(), limit, mimeType);
  }

  throw new Error("Too many redirects");
}

async function resolveMediaPageUrls(url: URL): Promise<URL[]> {
  if (isYandexDiskUrl(url.toString())) {
    const directUrl = await resolveYandexDiskMediaUrl(url, env.MAX_IMAGE_BYTES, env.MAX_VIDEO_BYTES);
    await assertSafeNetworkTarget(directUrl);
    return [directUrl];
  }
  if (!isResolvableMediaPageUrl(url.toString())) return [url];

  let pageUrl = url;
  for (let redirects = 0; redirects <= 4; redirects += 1) {
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

async function downloadPlatformVideo(rawUrl: string): Promise<DownloadResult> {
  if (!env.ENABLE_PLATFORM_DOWNLOADS) throw new Error("Platform downloads are disabled");

  const url = toUrl(rawUrl);
  if (!url) throw new Error("Invalid platform URL");
  assertSafeUrl(url);

  const limit = env.MAX_VIDEO_BYTES;
  const formatSelector = platformFormatSelector(limit);
  console.log(`[platform] metadata url=${url.toString()}`);
  await assertPlatformVideoFits(url.toString(), limit, formatSelector);
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
    `duration <= ${env.MAX_PLATFORM_VIDEO_SECONDS}`,
    "--format",
    formatSelector,
    "--merge-output-format",
    "mp4",
    "--output",
    outputTemplate,
    url.toString(),
  ];

  try {
    await runYtDlp(ytDlpArgs);

    const downloadedPath = await findDownloadedPlatformFile(tempDir);
    const result = await finalizeDownload(downloadedPath, "video", url.toString(), limit);
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

    const needsVideoConversion = finalMediaType === "video" && !alreadyProcessedVideo && !isTelegramMp4(finalPath, finalOriginalMimeType);
    const needsVideoCompression = finalMediaType === "video" && (await fs.promises.stat(finalPath)).size > telegramVideoMaxBytes;
    if (finalMediaType === "video" && (needsVideoConversion || needsVideoCompression)) {
      const inputPath = finalPath;
      finalPath = path.join(os.tmpdir(), `archive-video-${crypto.randomUUID()}.mp4`);
      console.log(`[video] transcoding input=${path.basename(inputPath)} output=${path.basename(finalPath)} target_bytes=${needsVideoCompression ? telegramVideoMaxBytes : "compatible"}`);
      await transcodeForTelegram(inputPath, finalPath, {
        targetBytes: needsVideoCompression ? telegramVideoMaxBytes : undefined,
        timeoutMs: env.PLATFORM_DOWNLOAD_TIMEOUT_MS,
      });
      await fs.promises.rm(inputPath, { force: true }).catch(() => undefined);
    }

    const result = await inspectDownloadedFile(finalPath, finalMediaType);
    if (result.byteSize > limit) {
      throw new Error(`Media exceeded byte limit after processing: ${result.byteSize} > ${limit}`);
    }
    if (finalMediaType === "video" && result.byteSize > telegramVideoMaxBytes) {
      throw new Error(`Telegram video exceeded upload limit after processing: ${result.byteSize} > ${telegramVideoMaxBytes}`);
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

function isTelegramMp4(filePath: string, mimeType: string | undefined): boolean {
  return getExtension(filePath) === "mp4" || mimeType?.split(";")[0]?.trim().toLowerCase() === "video/mp4";
}

async function assertPlatformVideoFits(url: string, limit: number, formatSelector: string): Promise<void> {
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
    ]),
  ) as PlatformMetadata;

  assertPlatformMetadataFits(metadata, limit, env.MAX_PLATFORM_VIDEO_SECONDS);
}

async function runYtDlp(args: string[]): Promise<string> {
  args = ["--js-runtimes", "node", ...args];
  const hostname = toUrl(args.at(-1) ?? "")?.hostname.toLowerCase();
  if (hostname && (hostname === "youtu.be" || hostname === "youtube.com" || hostname.endsWith(".youtube.com")) && fs.existsSync(youtubeCookiesFile)) {
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
  const bytes = Number(aggregate._sum.byteSize ?? 0n);
  if (bytes >= env.MAX_DAILY_DOWNLOAD_BYTES) throw new Error("Daily download limit reached");
}

async function markBlocked(jobId: string, chatPostId: string, reason: string): Promise<void> {
  await prisma.$transaction([
    prisma.chatPost.update({ where: { id: chatPostId }, data: { status: "blocked" } }),
    prisma.downloadJob.update({ where: { id: jobId }, data: { status: "blocked", lastError: reason } }),
  ]);
}
