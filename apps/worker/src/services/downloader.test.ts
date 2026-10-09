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
  telegramMediaGroupMaxItems: 10,
}));

describe("download failure cleanup", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    prismaMock.$queryRaw.mockResolvedValue([{ id: "job-1" }]);
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

  it("fails the asset and every pending post for the same URL after the last attempt", async () => {
    const { processDownloadQueue } = await import("./downloader.js");

    await processDownloadQueue();

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
    });
  });

});

describe("platform download lifecycle", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    prismaMock.$queryRaw.mockResolvedValue([{ id: "job-1" }]);
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
      const { processDownloadQueue } = await import("./downloader.js");

      await processDownloadQueue();

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
      const { processDownloadQueue } = await import("./downloader.js");

      await processDownloadQueue();

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
    prismaMock.$queryRaw.mockResolvedValue([{ id: "job-album" }]);
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
      const { processDownloadQueue } = await import("./downloader.js");
      await processDownloadQueue();

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
      const { processDownloadQueue } = await import("./downloader.js");
      await processDownloadQueue();

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
