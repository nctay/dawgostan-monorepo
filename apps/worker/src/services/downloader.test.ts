import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
  blockedMedia: { findUnique: vi.fn() },
  downloadJob: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  chatPost: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  asset: { aggregate: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), upsert: vi.fn() },
}));
const classifyNsfwMock = vi.hoisted(() => vi.fn());
const publishStoredTelegramMediaMock = vi.hoisted(() => vi.fn());
const storeTelegramMediaMock = vi.hoisted(() => vi.fn());
const storeTelegramMediaGroupMock = vi.hoisted(() => vi.fn());
const readVideoMetadataMock = vi.hoisted(() => vi.fn());

vi.mock("../env.js", () => ({
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

    await recoverInterruptedDownloadJobs();

    expect(prismaMock.downloadJob.updateMany).toHaveBeenCalledWith({
      where: {
        status: "running",
        updatedAt: { gte: expect.any(Date) },
        asset: {
          is: {
            status: "pending",
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

  it("claims another job when one download slot is still busy", async () => {
    const { env } = await import("../env.js");
    const previousSlots = env.MAX_PARALLEL_DOWNLOADS;
    env.MAX_PARALLEL_DOWNLOADS = 2;
    const fixture = await prismaMock.downloadJob.findUnique();
    let releaseSlow: () => void = () => undefined;
    const slowJob = new Promise((resolve) => { releaseSlow = () => resolve({ ...fixture, id: "slow" }); });
    prismaMock.$queryRaw.mockReset()
      .mockResolvedValueOnce([{ id: "slow" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "fast" }])
      .mockResolvedValueOnce([{ id: "later" }])
      .mockResolvedValue([]);
    prismaMock.downloadJob.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      where.id === "slow" ? slowJob : Promise.resolve({ ...fixture, id: where.id }),
    );
    const { processDownloadQueue, waitForDownloadQueue } = await import("./downloader.js");
    processDownloadQueue();

    try {
      await vi.waitFor(() => {
        processDownloadQueue();
        expect(prismaMock.$queryRaw.mock.calls.length).toBeGreaterThanOrEqual(5);
      });
      expect(prismaMock.downloadJob.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "later" } }));
    } finally {
      releaseSlow();
      await waitForDownloadQueue();
      env.MAX_PARALLEL_DOWNLOADS = previousSlots;
    }
  });

});

describe("platform download lifecycle", () => {
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
    storeTelegramMediaMock.mockResolvedValue({
      storageProvider: "telegram",
      telegramChatId: "-100storage",
      telegramMessageId: 1,
      telegramFileId: "file",
      telegramFileUniqueId: "unique",
    });
    publishStoredTelegramMediaMock.mockResolvedValue(undefined);
  });

  it("keeps a compatible platform video readable until storage completes", async () => {
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
