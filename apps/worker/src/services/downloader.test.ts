import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { classifyNsfw } from "@dawgostan/nsfw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "grammy";
import { convertAnimatedWebpToMp4, transcodeForTelegram } from "@dawgostan/media-processing";

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
  $transaction: vi.fn(),
  blockedMedia: { findUnique: vi.fn() },
  downloadJob: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  chatPost: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  asset: { aggregate: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), upsert: vi.fn() },
}));
const classifyNsfwMock = vi.hoisted(() => vi.fn());
const publishStoredTelegramMediaMock = vi.hoisted(() => vi.fn());
const storeTelegramMediaMock = vi.hoisted(() => vi.fn());
const storeTelegramMediaGroupMock = vi.hoisted(() => vi.fn());
const readVideoMetadataMock = vi.hoisted(() => vi.fn());
const readVideoCodecMock = vi.hoisted(() => vi.fn());

vi.mock("../env.js", () => ({
  privateStreamerLogins: new Set(),
  env: {
    ALLOW_PRIVATE_MEDIA_HOSTS: true,
    ENABLE_PLATFORM_DOWNLOADS: true,
    MAX_DAILY_DOWNLOAD_BYTES: 10_000_000,
    MAX_IMAGE_BYTES: 1_000_000,
    MAX_PARALLEL_DOWNLOADS: 1,
    MAX_PLATFORM_VIDEO_SECONDS: 300,
    MAX_VIDEO_BYTES: 1_000_000,
    PLATFORM_DOWNLOAD_TIMEOUT_MS: 10_000,
  },
}));

vi.mock("@dawgostan/media-processing", () => ({
  convertAnimatedWebpToMp4: vi.fn(),
  normalizePhotoForTelegram: vi.fn(async (filePath: string, mimeType?: string) => ({ filePath, mimeType: mimeType ?? "image/jpeg" })),
  transcodeForTelegram: vi.fn(),
}));

vi.mock("../prisma.js", () => ({
  prisma: prismaMock,
}));

vi.mock("./nsfw.js", () => ({
  classifyNsfw: classifyNsfwMock,
}));

vi.mock("./telegram-storage.js", () => ({
  publishStoredTelegramMedia: publishStoredTelegramMediaMock,
  storeTelegramMedia: storeTelegramMediaMock,
  storeTelegramMediaGroup: storeTelegramMediaGroupMock,
  readVideoMetadata: readVideoMetadataMock,
  readVideoCodec: readVideoCodecMock,
  telegramMediaGroupMaxItems: 10,
}));

describe("download failure cleanup", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    prismaMock.$queryRaw.mockResolvedValueOnce([{ id: "job-1" }]).mockResolvedValue([]);
    prismaMock.downloadJob.findUnique.mockResolvedValue({
      id: "job-1",
      assetId: "asset-1",
      chatPostId: "post-1",
      url: "not-a-url",
      attempts: 3,
      chatPost: {
        normalizedUrl: "https://example.com/media.jpg",
        streamSession: { streamer: {} },
      },
    });
    prismaMock.downloadJob.update.mockResolvedValue({});
    prismaMock.chatPost.updateMany.mockResolvedValue({ count: 2 });
    prismaMock.asset.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.$transaction.mockResolvedValue([]);
  });

  it("recovers interrupted jobs only when Telegram has no stored media record", async () => {
    const { recoverInterruptedDownloadJobs } = await import("./downloader.js");
    prismaMock.downloadJob.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.downloadJob.findMany.mockResolvedValue([]);

    await recoverInterruptedDownloadJobs();

    expect(prismaMock.downloadJob.updateMany).toHaveBeenCalledWith({
      where: {
        status: "running",
        updatedAt: { gte: expect.any(Date) },
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
  });

  it("fails the asset and every pending post for the same URL after the last attempt", async () => {
    const { processDownloadQueue, waitForDownloadQueue } = await import("./downloader.js");

    processDownloadQueue();
    await waitForDownloadQueue();

    expect(prismaMock.chatPost.updateMany).toHaveBeenCalledWith({
      where: {
        status: "pending",
        OR: [{ id: "post-1" }, { normalizedUrl: "https://example.com/media.jpg" }],
      },
      data: { status: "failed" },
    });
    expect(prismaMock.asset.updateMany).toHaveBeenCalledWith({
      where: { id: "asset-1", status: "pending" },
      data: { status: "failed" },
    });
    expect(prismaMock.$transaction).toHaveBeenCalledOnce();
    const alert = JSON.parse(String(vi.mocked(console.error).mock.calls[0]?.[0]));
    expect(alert).toMatchObject({
      alert_code: "download_failed",
      alert_title: "Не удалось скачать медиа",
      alert_context: "platform=unknown",
      details: { url: "not-a-url" },
    });
  });

  it.each([1, 3])("redacts Telegram network errors in logs and saved download attempt %i", async attempts => {
    const { processDownloadQueue, waitForDownloadQueue } = await import("./downloader.js");
    const job = await prismaMock.downloadJob.findUnique();
    prismaMock.downloadJob.findUnique.mockResolvedValue({ ...job, attempts, url: job.chatPost.normalizedUrl });
    prismaMock.asset.findUnique.mockResolvedValue({ id: job.assetId, status: "stored" });
    const token = "4567:worker_fixture";
    publishStoredTelegramMediaMock.mockRejectedValue(new HttpError("Network request failed",
      new Error(`request to https://api.telegram.org/bot${token}/copyMessage failed: ECONNRESET`)));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      processDownloadQueue();
      await waitForDownloadQueue();
      const lastError = prismaMock.downloadJob.update.mock.calls.at(-1)?.[0].data.lastError;
      expect(lastError).toContain("/bot[redacted]/copyMessage failed: ECONNRESET");
      const logs = [...warn.mock.calls, ...vi.mocked(console.error).mock.calls].flat().join("\n");
      expect(logs).toContain("ECONNRESET");
      expect(logs).not.toContain(token);
    } finally {
      warn.mockRestore();
    }
  });

  it("claims another job when one download slot is still busy", async () => {
    const { env } = await import("../env.js");
    const previousSlots = env.MAX_PARALLEL_DOWNLOADS;
    env.MAX_PARALLEL_DOWNLOADS = 2;
    const fixture = await prismaMock.downloadJob.findUnique();
    let releaseSlow: () => void = () => undefined;
    const slowJob = new Promise((resolve) => { releaseSlow = () => resolve({ ...fixture, id: "slow" }); });
    const claims = [[{ id: "slow" }], [], [{ id: "fast" }], [{ id: "later" }]];
    prismaMock.$queryRaw.mockReset().mockImplementation(async (sql: TemplateStringsArray) =>
      sql.join("").includes('UPDATE "download_jobs"') ? claims.shift() ?? [] : []);
    prismaMock.downloadJob.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      where.id === "slow" ? slowJob : Promise.resolve({ ...fixture, id: where.id }),
    );
    const { processDownloadQueue, waitForDownloadQueue } = await import("./downloader.js");
    processDownloadQueue();

    try {
      await vi.waitFor(() => {
        processDownloadQueue();
        expect(prismaMock.downloadJob.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "later" } }));
      });
    } finally {
      releaseSlow();
      await waitForDownloadQueue();
      env.MAX_PARALLEL_DOWNLOADS = previousSlots;
    }
  });

});

describe("platform download lifecycle", () => {
  const storedMedia = {
    storageProvider: "telegram",
    telegramChatId: "-100storage",
    telegramMessageId: 1,
    telegramFileId: "file",
    telegramFileUniqueId: "unique",
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    prismaMock.$queryRaw.mockResolvedValueOnce([{ id: "job-1" }]).mockResolvedValue([]);
    prismaMock.downloadJob.findUnique.mockResolvedValue({
      id: "job-1",
      assetId: "asset-1",
      chatPostId: "post-1",
      url: "https://clips.twitch.tv/FixtureClip",
      attempts: 1,
      chatPost: {
        normalizedUrl: "https://clips.twitch.tv/FixtureClip",
        authorName: "viewer",
        messageText: "https://clips.twitch.tv/FixtureClip",
        skipTelegramPublic: false,
        streamSession: {
          id: "session-1",
          startedAt: new Date("2026-10-03T17:00:00Z"),
          streamer: { login: "streamer", displayName: "Streamer" },
        },
      },
    });
    prismaMock.blockedMedia.findUnique.mockResolvedValue(null);
    prismaMock.asset.findUnique.mockResolvedValue(null);
    prismaMock.chatPost.findFirst.mockResolvedValue(null);
    prismaMock.asset.aggregate.mockResolvedValue({ _sum: { byteSize: 0n } });
    prismaMock.asset.upsert.mockResolvedValue({ id: "asset-1" });
    prismaMock.downloadJob.update.mockResolvedValue({});
    prismaMock.downloadJob.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.chatPost.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.asset.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.$transaction.mockResolvedValue([]);
    classifyNsfwMock.mockImplementation(async (filePath: string) => {
      await fs.promises.access(filePath, fs.constants.R_OK);
      return { publicSpoiler: false, status: "ok" };
    });
    readVideoCodecMock.mockResolvedValue("h264");
    readVideoMetadataMock.mockResolvedValue({ duration: 10 });
    storeTelegramMediaMock.mockResolvedValue(storedMedia);
    publishStoredTelegramMediaMock.mockResolvedValue(undefined);
  });

  it("stores the JPEG from a short link whose .jpg redirect leads to a Postimage page", async () => {
    const short = "https://bit.ly/fixture";
    const intermediate = "https://media.example/photo.jpg";
    const page = "https://postimg.cc/abcd";
    const photo = "https://i.postimg.cc/abcd/photo.jpg";
    const network = vi.fn(async (input: URL | string) => {
      switch (String(input)) {
        case short: return Response.redirect(intermediate);
        case intermediate: return Response.redirect(page);
        case page: return new Response(`<meta property="og:image" content="${photo}">`);
        case photo: return new Response("fixture-jpeg", { headers: { "content-type": "image/jpeg" } });
        default: throw new Error("Unexpected fixture URL");
      }
    });
    vi.stubGlobal("fetch", network);
    try {
      const { resolveSupportedMediaUrl } = await import("./redirect-resolver.js");
      const url = await resolveSupportedMediaUrl(short);
      const job = await prismaMock.downloadJob.findUnique();
      prismaMock.downloadJob.findUnique.mockResolvedValue({ ...job, url, chatPost: { ...job.chatPost, normalizedUrl: url } });
      const { processDownloadQueue, waitForDownloadQueue } = await import("./downloader.js");
      processDownloadQueue();
      await waitForDownloadQueue();

      expect(storeTelegramMediaMock).toHaveBeenCalledWith(expect.any(String), "image/jpeg", "image", expect.any(Object));
      expect(network.mock.calls.filter(([input]) => String(input) === photo)).toHaveLength(1);
      expect(url).toBe(page);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ["https://clips.twitch.tv/FixtureClip", "h264"],
    ["https://www.instagram.com/reel/FixtureReel/", "h264"],
    ["https://clips.twitch.tv/FixtureClip", "hevc"],
  ])("stores a platform video and reuses metadata only for an unchanged file: %s %s", async (url, codec) => {
    const videoMetadata = { duration: 10, width: 320, height: 180 };
    readVideoMetadataMock.mockResolvedValue(videoMetadata);
    readVideoCodecMock.mockResolvedValue(codec);
    vi.mocked(transcodeForTelegram).mockImplementation((_input, output) => fs.promises.writeFile(output, "converted"));
    const job = await prismaMock.downloadJob.findUnique();
    prismaMock.downloadJob.findUnique.mockResolvedValue({
      ...job,
      url,
      chatPost: { ...job.chatPost, normalizedUrl: url, messageText: url },
    });
    const binDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dawgostan-test-bin-"));
    const ytDlpPath = path.join(binDir, "yt-dlp");
    const previousPath = process.env.PATH;
    await fs.promises.writeFile(
      ytDlpPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--dump-json")) {
  process.stdout.write(JSON.stringify({ duration: 10, filesize: 13 }) + "\\n");
} else {
  const template = args[args.indexOf("--output") + 1];
  const output = template.replace("%(id)s", "fixture").replace("%(ext)s", "mp4");
  fs.writeFileSync(output, "fixture-video");
}
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;

    try {
      const { processDownloadQueue, waitForDownloadQueue } = await import("./downloader.js");

      processDownloadQueue();

      await waitForDownloadQueue();

      expect(storeTelegramMediaMock).toHaveBeenCalledOnce();
      expect(storeTelegramMediaMock).toHaveBeenCalledWith(expect.any(String), "video/mp4", "video",
        expect.objectContaining({ originalUrl: url, videoMetadata: codec === "h264" ? videoMetadata : undefined }));
      expect(publishStoredTelegramMediaMock).toHaveBeenCalledOnce();
      expect(prismaMock.asset.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ sha256s: [expect.any(String)] }),
          update: expect.objectContaining({ sha256s: [expect.any(String)] }),
        }),
      );
    } finally {
      process.env.PATH = previousPath;
      await fs.promises.rm(binDir, { force: true, recursive: true });
    }
  });

  it.each([10, 301, undefined])("checks the downloaded Reel when metadata has no duration: %s", async (duration) => {
    const job = await prismaMock.downloadJob.findUnique();
    const url = "https://www.instagram.com/reel/FixtureReel/";
    prismaMock.downloadJob.findUnique.mockResolvedValue({
      ...job, url, chatPost: { ...job.chatPost, normalizedUrl: url },
    });
    readVideoMetadataMock.mockResolvedValue({ duration });
    const binDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dawgostan-test-bin-"));
    const previousPath = process.env.PATH;
    await fs.promises.writeFile(path.join(binDir, "yt-dlp"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--dump-json")) {
  process.stdout.write(JSON.stringify({ filesize: 13 }));
} else {
  // yt-dlp skips unknown durations unless the comparison accepts missing values.
  if (!args[args.indexOf("--match-filter") + 1].includes("<=?")) process.exit(0);
  const template = args[args.indexOf("--output") + 1];
  fs.writeFileSync(template.replace("%(id)s", "fixture").replace("%(ext)s", "mp4"), "fixture-video");
}
`, { mode: 0o755 });
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;

    try {
      const { processDownloadQueue, waitForDownloadQueue } = await import("./downloader.js");
      processDownloadQueue();
      await waitForDownloadQueue();

      if (duration === 10) {
        expect(storeTelegramMediaMock).toHaveBeenCalledOnce();
        expect(publishStoredTelegramMediaMock).toHaveBeenCalledOnce();
      } else {
        expect(storeTelegramMediaMock).not.toHaveBeenCalled();
        expect(publishStoredTelegramMediaMock).not.toHaveBeenCalled();
        expect(prismaMock.downloadJob.update).toHaveBeenCalledWith({
          where: { id: "job-1" },
          data: {
            status: "failed",
            lastError: duration ? "Platform video is too long: 301s > 300s" : "Platform video duration unavailable",
            nextRetryAt: null,
          },
        });
      }
    } finally {
      process.env.PATH = previousPath;
      await fs.promises.rm(binDir, { force: true, recursive: true });
    }
  });

  it.each(["mp4", "gif"] as const)("hashes a direct %s once and persists the SHA-256 of the file sent to storage", async format => {
    const url = `https://cdn.example/fixture.${format}`;
    prismaMock.downloadJob.findUnique.mockResolvedValue({ ...(await prismaMock.downloadJob.findUnique()), url });
    const { stdout: source } = await promisify(execFile)("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=32x32:rate=4:duration=1",
      ...(format === "mp4" ? ["-c:v", "libx264", "-movflags", "frag_keyframe+empty_moov"] : []),
      "-f", format, "pipe:1",
    ], { encoding: "buffer" });
    const mediaProcessing = await vi.importActual<typeof import("@dawgostan/media-processing")>("@dawgostan/media-processing");
    vi.mocked(transcodeForTelegram).mockImplementation(mediaProcessing.transcodeForTelegram);
    let uploaded: Buffer | undefined;
    storeTelegramMediaMock.mockImplementationOnce(async (filePath: string) => {
      uploaded = await fs.promises.readFile(filePath);
      return storedMedia;
    });
    const { processDownloadQueue, waitForDownloadQueue } = await import("./downloader.js");
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array(source), {
      headers: { "content-type": format === "mp4" ? "video/mp4" : "image/gif" },
    }));
    const hashes = vi.spyOn(crypto, "createHash");
    try {
      processDownloadQueue();
      await waitForDownloadQueue();
      expect(uploaded).toBeDefined();
      expect(uploaded!.equals(source)).toBe(format === "mp4");
      const sha256 = crypto.hash("sha256", uploaded!);
      const asset = expect.objectContaining({ sha256, sha256s: [sha256], byteSize: uploaded!.length });
      expect(prismaMock.asset.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: asset, update: asset }));
      expect(prismaMock.asset.findUnique).toHaveBeenCalledWith({ where: { sha256 } });
      expect(prismaMock.blockedMedia.findUnique).toHaveBeenCalledWith({ where: { sha256 } });
      expect(hashes.mock.calls.filter(([algorithm]) => algorithm === "sha256")).toHaveLength(1);
    } finally {
      hashes.mockRestore();
      fetch.mockRestore();
    }
  });

  it("stops a direct download at the byte limit without Content-Length and removes the partial file", async () => {
    const url = "https://cdn.example/oversized.mp4";
    prismaMock.downloadJob.findUnique.mockResolvedValue({ ...(await prismaMock.downloadJob.findUnique()), url });
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "archive-download-limit-"));
    const tmpdir = vi.spyOn(os, "tmpdir").mockReturnValue(tempDir);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(600_000));
        controller.enqueue(new Uint8Array(600_000));
        controller.close();
      },
    }), { headers: { "content-type": "video/mp4" } }));
    try {
      const { processDownloadQueue, waitForDownloadQueue } = await import("./downloader.js");
      processDownloadQueue();
      await waitForDownloadQueue();
      expect(prismaMock.downloadJob.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: "failed", lastError: "Media exceeded byte limit 1000000" }),
      }));
      expect(storeTelegramMediaMock).not.toHaveBeenCalled();
      expect(await fs.promises.readdir(tempDir)).toEqual([]);
    } finally {
      fetch.mockRestore();
      tmpdir.mockRestore();
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("transcodes an HEVC MP4 before storing it in Telegram", async () => {
    prismaMock.downloadJob.findUnique.mockResolvedValue({
      ...(await prismaMock.downloadJob.findUnique()),
      url: "https://cdn.example/clip.mp4",
    });
    readVideoCodecMock.mockResolvedValue("hevc");
    vi.mocked(transcodeForTelegram).mockImplementation(async (_inputPath, outputPath) => {
      await fs.promises.writeFile(outputPath, "h264-video");
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("hevc-video", { headers: { "content-type": "video/mp4" } }),
    );

    try {
      const { processDownloadQueue, waitForDownloadQueue } = await import("./downloader.js");
      processDownloadQueue();
      await waitForDownloadQueue();

      expect(transcodeForTelegram).toHaveBeenCalledOnce();
      expect(storeTelegramMediaMock).toHaveBeenCalledOnce();
    } finally {
      fetchMock.mockRestore();
    }
  });

  describe.each(["gif", "webp"])("oversized %s animation", (format) => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "animation-cleanup-"));
      vi.spyOn(os, "tmpdir").mockReturnValue(tempDir);
      const url = `https://cdn.example/animation.${format}`;
      prismaMock.downloadJob.findUnique.mockResolvedValue({ ...(await prismaMock.downloadJob.findUnique()), url });
      const body = format === "gif" ? "GIF89a" : "RIFF\x10\0\0\0WEBPANIM\0\0\0\0";
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { headers: { "content-type": `image/${format}` } }));

      const convert = format === "gif" ? transcodeForTelegram : convertAnimatedWebpToMp4;
      vi.mocked(convert).mockImplementationOnce(async (_input, output) => {
        await fs.promises.writeFile(output, "");
        await fs.promises.truncate(output, 50_000_000);
      });
    });

    afterEach(async () => {
      vi.mocked(globalThis.fetch).mockRestore();
      vi.mocked(os.tmpdir).mockRestore();
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    });

    it("removes the intermediate and partial MP4 when recompression fails", async () => {
      vi.mocked(transcodeForTelegram).mockImplementationOnce(async (_input, output) => {
        await fs.promises.writeFile(output, "partial video");
        throw new Error("compression failed");
      });
      const { processDownloadQueue, waitForDownloadQueue } = await import("./downloader.js");
      processDownloadQueue();
      await waitForDownloadQueue();

      expect(prismaMock.downloadJob.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: "pending", lastError: "compression failed" }),
      }));
      expect(storeTelegramMediaMock).not.toHaveBeenCalled();
      expect(await fs.promises.readdir(tempDir)).toEqual([]);
    });

    it("keeps only the compressed animation until Telegram storage reads it", async () => {
      vi.mocked(transcodeForTelegram).mockImplementationOnce((_input, output) => fs.promises.writeFile(output, "compressed video"));
      storeTelegramMediaMock.mockImplementationOnce(async (filePath: string) => {
        expect(await fs.promises.readdir(tempDir)).toEqual([path.basename(filePath)]);
        expect(await fs.promises.readFile(filePath, "utf8")).toBe("compressed video");
        return storedMedia;
      });
      const { processDownloadQueue, waitForDownloadQueue } = await import("./downloader.js");
      processDownloadQueue();
      await waitForDownloadQueue();

      expect(storeTelegramMediaMock).toHaveBeenCalledWith(expect.any(String), "video/mp4", "video", expect.objectContaining({ telegramSendAsAnimation: true }));
      expect(publishStoredTelegramMediaMock).toHaveBeenCalledOnce();
      expect(await fs.promises.readdir(tempDir)).toEqual([]);
    });
  });

  it("stores all 18 images from a TikTok photo post", async () => {
    const binDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dawgostan-test-bin-"));
    const previousPath = process.env.PATH;
    await fs.promises.writeFile(path.join(binDir, "gallery-dl"), `#!/usr/bin/env node
process.stdout.write(Array.from({ length: 18 }, (_, index) => "https://cdn.example/" + index + ".jpg").join("\\n") + "\\n");
`, { mode: 0o755 });
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    prismaMock.downloadJob.findUnique.mockResolvedValue({
      ...(await prismaMock.downloadJob.findUnique()),
      url: "https://vt.tiktok.com/ZSgjhmxsJ/",
    });
    storeTelegramMediaGroupMock.mockResolvedValue({
      storageProvider: "telegram", telegramChatId: "-100storage", telegramMessageId: 1,
      telegramMessageIds: [1, 2], telegramFileId: "file", telegramFileIds: ["file", "file2"], telegramFileUniqueId: "unique",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).startsWith("https://vt.tiktok.com/")) {
        return new Response(null, { status: 301, headers: { location: "https://www.tiktok.com/@ertz_aethe/photo/7677117145024777493" } });
      }
      if (init?.method === "HEAD") return new Response(null, { headers: { "content-type": "image/jpeg", "content-length": "12" } });
      return new Response("fixture-photo", { headers: { "content-type": "image/jpeg" } });
    });

    try {
      const { processDownloadQueue, waitForDownloadQueue } = await import("./downloader.js");
      processDownloadQueue();
      await waitForDownloadQueue();

      expect(storeTelegramMediaGroupMock).toHaveBeenCalledWith(expect.arrayContaining([
        expect.objectContaining({ mimeType: "image/jpeg" }),
      ]), expect.objectContaining({ originalUrl: "https://vt.tiktok.com/ZSgjhmxsJ/" }));
      expect(storeTelegramMediaGroupMock.mock.calls[0]?.[0]).toHaveLength(18);
      expect(storeTelegramMediaMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
      process.env.PATH = previousPath;
      await fs.promises.rm(binDir, { force: true, recursive: true });
    }
  });

  it("does not retry or error-log a platform video rejected by the duration limit", async () => {
    const binDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dawgostan-test-bin-"));
    const ytDlpPath = path.join(binDir, "yt-dlp");
    const previousPath = process.env.PATH;
    await fs.promises.writeFile(
      ytDlpPath,
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ duration: 595, filesize: 13 }) + "\\n");
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;

    try {
      const { processDownloadQueue, waitForDownloadQueue } = await import("./downloader.js");

      processDownloadQueue();

      await waitForDownloadQueue();

      expect(prismaMock.downloadJob.update).toHaveBeenCalledWith({
        where: { id: "job-1" },
        data: {
          status: "failed",
          lastError: "Platform video is too long: 595s > 300s",
          nextRetryAt: null,
        },
      });
      expect(console.error).not.toHaveBeenCalled();
      expect(console.info).toHaveBeenCalledWith(expect.stringContaining("[download] rejected"));
    } finally {
      process.env.PATH = previousPath;
      await fs.promises.rm(binDir, { force: true, recursive: true });
    }
  });
});

describe("media album limits", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    prismaMock.$queryRaw.mockResolvedValueOnce([{ id: "job-album" }]).mockResolvedValue([]);
    prismaMock.downloadJob.findUnique.mockResolvedValue({
      id: "job-album",
      assetId: "asset-album",
      chatPostId: "post-album",
      url: "https://eblo.id/ALBUM01",
      attempts: 1,
      chatPost: {
        normalizedUrl: "https://eblo.id/ALBUM01",
        authorName: "viewer",
        messageText: "https://eblo.id/ALBUM01",
        skipTelegramPublic: false,
        streamSession: {
          id: "session-1",
          startedAt: new Date("2026-10-03T17:00:00Z"),
          streamer: { login: "streamer", displayName: "Streamer" },
        },
      },
    });
    prismaMock.blockedMedia.findUnique.mockResolvedValue(null);
    prismaMock.asset.findUnique.mockResolvedValue(null);
    prismaMock.chatPost.findFirst.mockResolvedValue(null);
    prismaMock.asset.aggregate.mockResolvedValue({ _sum: { byteSize: 0n } });
    prismaMock.downloadJob.update.mockResolvedValue({});
    prismaMock.chatPost.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.asset.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.$transaction.mockResolvedValue([]);
    readVideoCodecMock.mockResolvedValue("h264");
  });

  it("stores both images from an Imgur album as one Telegram album", async () => {
    const albumUrl = "https://imgur.com/a/123-sAUWwPJ";
    classifyNsfwMock.mockResolvedValue({ publicSpoiler: false, status: "ok" });
    prismaMock.asset.upsert.mockResolvedValue({ id: "asset-album" });
    prismaMock.downloadJob.updateMany.mockResolvedValue({ count: 0 });
    publishStoredTelegramMediaMock.mockResolvedValue(undefined);
    prismaMock.downloadJob.findUnique.mockResolvedValue({
      ...(await prismaMock.downloadJob.findUnique()),
      url: albumUrl,
    });
    storeTelegramMediaGroupMock.mockResolvedValue({
      storageProvider: "telegram", telegramChatId: "-100storage", telegramMessageId: 1,
      telegramMessageIds: [1, 2], telegramFileId: "file", telegramFileIds: ["file", "file2"], telegramFileUniqueId: "unique",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input) === "https://imgur.com/ajaxalbums/getimages/sAUWwPJ/hit.json") {
        return Response.json({ success: true, data: { count: 2, images: [
          { hash: "WgpOwku", ext: ".jpg" }, { hash: "8ND0DCy", ext: ".jpg" },
        ] } });
      }
      if (init?.method === "HEAD") return new Response(null, { headers: { "content-type": "image/jpeg", "content-length": "12" } });
      return new Response("fixture-photo", { headers: { "content-type": "image/jpeg" } });
    });

    try {
      const { processDownloadQueue, waitForDownloadQueue } = await import("./downloader.js");
      processDownloadQueue();
      await waitForDownloadQueue();

      expect(fetchMock).toHaveBeenCalledWith("https://imgur.com/ajaxalbums/getimages/sAUWwPJ/hit.json", expect.anything());
      expect(storeTelegramMediaGroupMock).toHaveBeenCalledWith(
        [expect.objectContaining({ mimeType: "image/jpeg" }), expect.objectContaining({ mimeType: "image/jpeg" })],
        expect.objectContaining({ originalUrl: albumUrl }),
      );
      expect(storeTelegramMediaMock).not.toHaveBeenCalled();
      expect(classifyNsfwMock).toHaveBeenCalledTimes(2);
      expect(prismaMock.asset.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({ publicHasSpoiler: false }),
      }));
    } finally {
      fetchMock.mockRestore();
    }
  });

  it.each(["threshold", "service error"])("stores the whole album after the first video frame triggers a spoiler: %s", async reason => {
    const { stdout: video } = await promisify(execFile)("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "color=size=32x32:rate=1:duration=8",
      "-c:v", "mpeg4", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1",
    ], { encoding: "buffer" });
    const classifierUrl = "http://classifier.test/classify";
    classifyNsfwMock.mockImplementation((file, type, animated) =>
      classifyNsfw(file, type, animated, { ensembleClassifierUrl: classifierUrl, ensembleThreshold: 0.8, maxFrames: 8 }));
    readVideoMetadataMock.mockResolvedValue({ duration: 8, width: 32, height: 32 });
    prismaMock.asset.upsert.mockResolvedValue({ id: "asset-album" });
    storeTelegramMediaGroupMock.mockResolvedValue({ telegramMessageIds: [1, 2, 3] });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const url = String(input);
      if (url === classifierUrl) {
        return reason === "threshold" ? Response.json({ owen: 0.8, siglip: 0.1 }) : new Response(null, { status: 503 });
      }
      if (url === "https://eblo.id/ALBUM01") return new Response(
        '<video class="album-media" src="https://cdn.example/clip.mp4"></video>' +
        '<img class="album-media" src="https://cdn.example/a.jpg"><img class="album-media" src="https://cdn.example/b.jpg">',
      );
      if (url.endsWith(".mp4")) return new Response(new Uint8Array(video), { headers: { "content-type": "video/mp4" } });
      return new Response("photo", { headers: { "content-type": "image/jpeg" } });
    });
    try {
      const { processDownloadQueue, waitForDownloadQueue } = await import("./downloader.js");
      processDownloadQueue();
      await waitForDownloadQueue();

      expect(fetchMock.mock.calls.filter(([url]) => String(url) === classifierUrl)).toHaveLength(1);
      expect(classifyNsfwMock.mock.calls.map(([, type]) => type)).toEqual(["video"]);
      expect(storeTelegramMediaGroupMock.mock.calls[0]?.[0].map((item: { mediaType: string }) => item.mediaType)).toEqual(["video", "image", "image"]);
      expect(prismaMock.asset.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({ publicHasSpoiler: true }), update: expect.objectContaining({ publicHasSpoiler: true }),
      }));
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("keeps a supported video beside an Imgur photo", async () => {
    const albumUrl = "https://imgur.com/a/123-sAUWwPJ";
    prismaMock.downloadJob.findUnique.mockResolvedValue({ ...(await prismaMock.downloadJob.findUnique()), url: albumUrl });
    prismaMock.asset.upsert.mockResolvedValue({ id: "asset-album" });
    prismaMock.downloadJob.updateMany.mockResolvedValue({ count: 0 });
    classifyNsfwMock.mockResolvedValue({ publicSpoiler: false, status: "ok" });
    readVideoMetadataMock.mockResolvedValue({ duration: 10, width: 16, height: 16 });
    storeTelegramMediaGroupMock.mockResolvedValue({
      storageProvider: "telegram", telegramChatId: "-100storage", telegramMessageId: 1,
      telegramMessageIds: [1, 2], telegramFileId: "photo", telegramFileIds: ["photo", "video"],
      telegramMediaTypes: ["photo", "video"], telegramFileUniqueId: "unique",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("ajaxalbums")) return Response.json({ success: true, data: { count: 2, images: [
        { hash: "WgpOwku", ext: ".jpg" }, { hash: "8ND0DCy", ext: ".mp4" },
      ] } });
      return new Response("fixture-media", { headers: { "content-type": url.endsWith(".mp4") ? "video/mp4" : "image/jpeg" } });
    });

    try {
      const { processDownloadQueue, waitForDownloadQueue } = await import("./downloader.js");
      processDownloadQueue();
      await waitForDownloadQueue();

      expect(storeTelegramMediaGroupMock.mock.calls[0]?.[0].map((item: { mediaType: string }) => item.mediaType)).toEqual(["image", "video"]);
      expect(storeTelegramMediaGroupMock.mock.calls[0]?.[0][1].videoMetadata).toEqual({ duration: 10, width: 16, height: 16 });
      expect(prismaMock.asset.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({ telegramMediaTypes: ["photo", "video"] }),
      }));
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("skips an oversized video and still stores the photo", async () => {
    prismaMock.asset.upsert.mockResolvedValue({ id: "asset-album" });
    prismaMock.downloadJob.updateMany.mockResolvedValue({ count: 0 });
    classifyNsfwMock.mockResolvedValue({ publicSpoiler: false, status: "ok" });
    storeTelegramMediaMock.mockResolvedValue({
      storageProvider: "telegram", telegramChatId: "-100storage", telegramMessageId: 1,
      telegramMessageIds: [1], telegramFileId: "photo", telegramFileIds: ["photo"],
      telegramMediaTypes: ["photo"], telegramFileUniqueId: "unique",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://eblo.id/ALBUM01") return new Response(
        '<img class="album-media" src="https://cdn.example/photo.jpg"><video class="album-media" src="https://cdn.example/clip.mp4"></video>',
      );
      if (url.endsWith(".mp4")) return new Response("oversized", { headers: { "content-type": "video/mp4", "content-length": "2000000" } });
      return new Response("fixture-photo", { headers: { "content-type": "image/jpeg" } });
    });

    try {
      const { processDownloadQueue, waitForDownloadQueue } = await import("./downloader.js");
      processDownloadQueue();
      await waitForDownloadQueue();

      expect(storeTelegramMediaMock).toHaveBeenCalledOnce();
      expect(storeTelegramMediaGroupMock).not.toHaveBeenCalled();
      expect(prismaMock.downloadJob.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "failed" }) }));
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("skips a video longer than five minutes and still stores the photo", async () => {
    prismaMock.asset.upsert.mockResolvedValue({ id: "asset-album" });
    prismaMock.downloadJob.updateMany.mockResolvedValue({ count: 0 });
    classifyNsfwMock.mockResolvedValue({ publicSpoiler: false, status: "ok" });
    readVideoMetadataMock.mockResolvedValue({ duration: 301, width: 16, height: 16 });
    storeTelegramMediaMock.mockResolvedValue({
      storageProvider: "telegram", telegramChatId: "-100storage", telegramMessageId: 1,
      telegramMessageIds: [1], telegramFileId: "photo", telegramFileIds: ["photo"],
      telegramMediaTypes: ["photo"], telegramFileUniqueId: "unique",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://eblo.id/ALBUM01") return new Response(
        '<img class="album-media" src="https://cdn.example/photo.jpg"><video class="album-media" src="https://cdn.example/clip.mp4"></video>',
      );
      return new Response("fixture-media", { headers: { "content-type": url.endsWith(".mp4") ? "video/mp4" : "image/jpeg" } });
    });

    try {
      const { processDownloadQueue, waitForDownloadQueue } = await import("./downloader.js");
      processDownloadQueue();
      await waitForDownloadQueue();

      expect(storeTelegramMediaMock).toHaveBeenCalledOnce();
      expect(storeTelegramMediaGroupMock).not.toHaveBeenCalled();
      expect(prismaMock.asset.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({ telegramMediaTypes: ["photo"] }),
      }));
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("drops an earlier video if a later photo needs the album byte budget", async () => {
    prismaMock.asset.upsert.mockResolvedValue({ id: "asset-album" });
    prismaMock.downloadJob.updateMany.mockResolvedValue({ count: 0 });
    classifyNsfwMock.mockResolvedValue({ publicSpoiler: false, status: "ok" });
    readVideoMetadataMock.mockResolvedValue({ duration: 10, width: 16, height: 16 });
    storeTelegramMediaMock.mockResolvedValue({
      storageProvider: "telegram", telegramChatId: "-100storage", telegramMessageId: 1,
      telegramMessageIds: [1], telegramFileId: "photo", telegramFileIds: ["photo"],
      telegramMediaTypes: ["photo"], telegramFileUniqueId: "unique",
    });
    const payload = new Uint8Array(600_000);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://eblo.id/ALBUM01") return new Response(
        '<video class="album-media" src="https://cdn.example/clip.mp4"></video><img class="album-media" src="https://cdn.example/photo.jpg">',
      );
      return new Response(payload, { headers: { "content-type": url.endsWith(".mp4") ? "video/mp4" : "image/jpeg" } });
    });

    try {
      const { processDownloadQueue, waitForDownloadQueue } = await import("./downloader.js");
      processDownloadQueue();
      await waitForDownloadQueue();

      expect(storeTelegramMediaMock).toHaveBeenCalledOnce();
      expect(storeTelegramMediaMock.mock.calls[0]?.[2]).toBe("image");
      expect(storeTelegramMediaGroupMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("rejects an oversized album without retrying and removes every temp file", async () => {
    const payload = new Uint8Array(600_000);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "https://eblo.id/ALBUM01") {
        return new Response('<img class="album-media" src="https://cdn.example/one.jpg"><img class="album-media" src="https://cdn.example/two.jpg">', {
          headers: { "content-type": "text/html" },
        });
      }
      if (init?.method === "HEAD") {
        return new Response(null, { headers: { "content-type": "image/jpeg", "content-length": String(payload.byteLength) } });
      }
      return new Response(payload, { headers: { "content-type": "image/jpeg" } });
    });
    const createdPaths: string[] = [];
    const originalCreateWriteStream = fs.createWriteStream.bind(fs);
    const createWriteStreamSpy = vi.spyOn(fs, "createWriteStream").mockImplementation(((filePath: fs.PathLike, ...args: Parameters<typeof fs.createWriteStream>[1][]) => {
      createdPaths.push(String(filePath));
      return originalCreateWriteStream(filePath, ...args);
    }) as typeof fs.createWriteStream);

    try {
      const { processDownloadQueue, waitForDownloadQueue } = await import("./downloader.js");
      processDownloadQueue();
      await waitForDownloadQueue();

      expect(prismaMock.downloadJob.update).toHaveBeenCalledWith({
        where: { id: "job-album" },
        data: {
          status: "failed",
          lastError: "Media album is too large: 1200000 > 1000000",
          nextRetryAt: null,
        },
      });
      expect(console.error).not.toHaveBeenCalled();
      expect(createdPaths).toHaveLength(2);
      await Promise.all(createdPaths.map((filePath) => expect(fs.promises.access(filePath)).rejects.toThrow()));
    } finally {
      fetchMock.mockRestore();
      createWriteStreamSpy.mockRestore();
      await Promise.all(createdPaths.map((filePath) => fs.promises.rm(filePath, { force: true })));
    }
  });

  it("rejects more than ten album items before downloading them", async () => {
    const html = Array.from({ length: 11 }, (_, index) => `<img class="album-media" src="https://cdn.example/${index}.jpg">`).join("");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(html, { headers: { "content-type": "text/html" } }));

    try {
      const { processDownloadQueue, waitForDownloadQueue } = await import("./downloader.js");
      processDownloadQueue();
      await waitForDownloadQueue();

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(prismaMock.downloadJob.update).toHaveBeenCalledWith({
        where: { id: "job-album" },
        data: {
          status: "failed",
          lastError: "Media album has too many items: 11 > 10",
          nextRetryAt: null,
        },
      });
      expect(console.error).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });
});
