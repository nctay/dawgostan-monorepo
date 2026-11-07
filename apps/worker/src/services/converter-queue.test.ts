import { beforeEach, describe, expect, it, vi } from "vitest";
import { GrammyError } from "grammy";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const env = vi.hoisted(() => ({
  TELEGRAM_CONVERTER_BOT_TOKEN: "123456:converter-token", TELEGRAM_CONVERTER_ALLOWED_USERNAMES: "@Alice,bob", TELEGRAM_STORAGE_CHAT_ID: "-100storage",
  TELEGRAM_CONVERTER_TEST_CHANNEL_ID: "-100123",
  ALLOW_PRIVATE_MEDIA_HOSTS: true, ENABLE_PLATFORM_DOWNLOADS: true, MAX_DAILY_DOWNLOAD_BYTES: 10_000_000,
  MAX_VIDEO_BYTES: 1_000_000, MAX_IMAGE_BYTES: 1_000_000, MAX_PLATFORM_VIDEO_SECONDS: 300, MAX_PARALLEL_DOWNLOADS: 1, PLATFORM_DOWNLOAD_TIMEOUT_MS: 10_000,
}));
const db = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  asset: { aggregate: vi.fn() },
  downloadJob: { updateMany: vi.fn() },
  conversionRequest: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findMany: vi.fn(), aggregate: vi.fn() },
  converterUser: { findUnique: vi.fn() },
}));
const telegram = vi.hoisted(() => ({
  sendVideo: vi.fn(), sendMessage: vi.fn(), editMessageMedia: vi.fn(), deleteMessage: vi.fn(),
  getMe: vi.fn(), getChatMember: vi.fn(),
}));
const archive = vi.hoisted(() => ({ publishStoredTelegramMedia: vi.fn(), storeTelegramMedia: vi.fn() }));
const probe = vi.hoisted(() => vi.fn());
vi.mock("../env.js", () => ({ env }));
vi.mock("../prisma.js", () => ({ prisma: db }));
vi.mock("grammy", async (original) => ({
  ...await original<typeof import("grammy")>(), Bot: vi.fn(function () { return { api: telegram }; }),
}));
vi.mock("./telegram-storage.js", () => ({
  ...archive, readVideoMetadata: probe, readVideoCodec: vi.fn(async () => "h264"), telegramMediaGroupMaxItems: 10,
}));

import { processDownloadQueue, recoverInterruptedDownloadJobs, waitForDownloadQueue } from "./downloader.js";

describe("conversion request queue", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    let claimed = false;
    db.$queryRaw.mockImplementation(async (sql: TemplateStringsArray) => {
      if (sql.join("").includes('"conversion_requests"') && !claimed) { claimed = true; return [{ id: "request-1" }]; }
      return [];
    });
    db.conversionRequest.findUnique.mockResolvedValue({
      id: "request-1", ownerId: 1n, chatId: 1n, sourceMessageId: 1, status: "downloading",
      originalUrl: "https://cdn.example/video.mp4", normalizedUrl: "https://cdn.example/video.mp4",
      owner: { username: "alice", telegramUserId: 1n },
    });
    db.conversionRequest.update.mockImplementation(async ({ data }: { data: { status: string } }) => {
      if (data.status === "pending") claimed = false;
      return {};
    });
    db.conversionRequest.findFirst.mockResolvedValue(null);
    db.conversionRequest.aggregate.mockResolvedValue({ _sum: { byteSize: 0n } });
    db.asset.aggregate.mockResolvedValue({ _sum: { byteSize: 0n } });
    probe.mockResolvedValue({ width: 720, height: 1280, duration: 12 });
    telegram.sendVideo.mockResolvedValueOnce({ message_id: 101, video: { file_id: "converter-file" } }).mockResolvedValue({ message_id: 102 });
    telegram.sendMessage.mockResolvedValue({ message_id: 103 });
    telegram.getMe.mockResolvedValue({ id: 123456 });
    telegram.getChatMember.mockResolvedValue({ status: "administrator", can_post_messages: true, can_delete_messages: true });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("fixture-video", { headers: { "content-type": "video/mp4" } }));
  });

  it("stores a private prepared video and delivers this bot's file_id to its owner", async () => {
    processDownloadQueue();
    await waitForDownloadQueue();
    expect(telegram.sendVideo).toHaveBeenCalledWith("-100storage", expect.anything(), expect.objectContaining({ width: 720, height: 1280, duration: 12, supports_streaming: true }));
    expect(telegram.sendVideo).toHaveBeenCalledWith("1", "converter-file", expect.objectContaining({ supports_streaming: true }));
    expect(archive.storeTelegramMedia).not.toHaveBeenCalled();
    expect(archive.publishStoredTelegramMedia).not.toHaveBeenCalled();
    expect(db.conversionRequest.update).toHaveBeenCalledWith({ where: { id: "request-1" }, data: expect.objectContaining({ status: "done", telegramMessageId: 102 }) });
  });

  it.each(["edited", "cannot edit", "timeout", "publish rejected", "no delete permission"])("handles a channel conversion when Telegram reports %s", async (outcome) => {
    db.conversionRequest.findUnique.mockResolvedValue({
      ...(await db.conversionRequest.findUnique()), owner: null, ownerId: null, chatId: -100123n,
      channelPostKey: "-100123:1", sourcePostedAt: new Date(), caption: "Момент Ссылка", captionLinkOffset: 7,
    });
    db.conversionRequest.findFirst.mockResolvedValue({ telegramFileId: "cached-file", storageMessageId: 55 });
    if (outcome === "timeout") telegram.editMessageMedia.mockRejectedValue(new Error("timeout"));
    if (outcome === "cannot edit" || outcome === "publish rejected" || outcome === "no delete permission") {
      telegram.editMessageMedia.mockRejectedValue(new GrammyError("Bad Request", { ok: false, error_code: 400, description: "Bad Request: message can't be edited" }, "editMessageMedia", {}));
    }
    if (outcome === "publish rejected") telegram.sendVideo.mockReset().mockRejectedValueOnce(new Error("timeout"));
    if (outcome === "no delete permission") telegram.getChatMember.mockResolvedValue({ status: "administrator", can_post_messages: true, can_delete_messages: false });
    processDownloadQueue();
    await waitForDownloadQueue();
    expect(telegram.editMessageMedia).toHaveBeenCalledWith("-100123", 1, {
      type: "video", media: "cached-file", caption: "Момент Ссылка", supports_streaming: true,
      caption_entities: [{ type: "text_link", offset: 7, length: 6, url: "https://cdn.example/video.mp4" }],
    });
    expect(telegram.sendVideo).toHaveBeenCalledTimes(outcome === "cannot edit" || outcome === "publish rejected" ? 1 : 0);
    if (outcome === "cannot edit") {
      expect(telegram.deleteMessage).toHaveBeenCalledWith("-100123", 1);
      expect(telegram.sendVideo.mock.invocationCallOrder[0]).toBeLessThan(telegram.deleteMessage.mock.invocationCallOrder[0]!);
    } else {
      expect(telegram.deleteMessage).not.toHaveBeenCalled();
    }
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it("recovers a download after restart but never repeats an uncertain Telegram send", async () => {
    db.downloadJob.updateMany.mockResolvedValue({ count: 0 });
    db.conversionRequest.findMany.mockResolvedValue([{ id: "request-2", chatId: 2n, owner: { username: "bob" }, status: "delivering" }]);
    await recoverInterruptedDownloadJobs();
    expect(db.conversionRequest.updateMany).toHaveBeenCalledWith({ where: { status: "downloading" }, data: { status: "pending" } });
    expect(db.conversionRequest.update).toHaveBeenCalledWith({ where: { id: "request-2" }, data: expect.objectContaining({ status: "uncertain" }) });
    expect(telegram.sendMessage).toHaveBeenCalledWith("2", expect.stringContaining("Результат отправки неизвестен"));
    expect(telegram.sendVideo).not.toHaveBeenCalled();
  });

  it.each(["too long", "missing metadata", "upload timeout", "delivery timeout", "revoked"])("does not publish or retry an unsafe conversion: %s", async (reason) => {
    if (reason === "too long") probe.mockResolvedValue({ width: 720, height: 1280, duration: 301 });
    if (reason === "missing metadata") probe.mockResolvedValue({});
    if (reason === "upload timeout") telegram.sendVideo.mockReset().mockRejectedValue(new Error("timeout"));
    if (reason === "delivery timeout") telegram.sendVideo.mockReset().mockResolvedValueOnce({ message_id: 101, video: { file_id: "converter-file" } }).mockRejectedValue(new Error("timeout"));
    if (reason === "revoked") db.conversionRequest.findUnique.mockResolvedValue({ ...(await db.conversionRequest.findUnique()), owner: { username: "removed" } });
    processDownloadQueue();
    await waitForDownloadQueue();
    expect(archive.publishStoredTelegramMedia).not.toHaveBeenCalled();
    expect(telegram.sendVideo).toHaveBeenCalledTimes(reason === "upload timeout" ? 1 : reason === "delivery timeout" ? 2 : 0);
    expect(db.conversionRequest.update).toHaveBeenCalledWith({ where: { id: "request-1" }, data: expect.objectContaining({ status: reason.includes("timeout") ? "uncertain" : "failed" }) });
  });

  it("reports an explicit Telegram rejection as a failure, not an unknown send", async () => {
    telegram.sendVideo.mockReset().mockRejectedValue(new GrammyError("Forbidden", { ok: false, error_code: 403, description: "Forbidden" }, "sendVideo", {}));
    processDownloadQueue();
    await waitForDownloadQueue();
    expect(db.conversionRequest.update).toHaveBeenCalledWith({ where: { id: "request-1" }, data: expect.objectContaining({ status: "failed" }) });
    expect(telegram.sendMessage).toHaveBeenCalledWith("1", expect.stringContaining("Telegram отклонил"));
  });

  it("reuses the converter's stored video without posting another storage message", async () => {
    db.conversionRequest.findFirst.mockResolvedValue({ telegramFileId: "stored-converter-file", storageMessageId: 55 });
    processDownloadQueue();
    await waitForDownloadQueue();
    expect(telegram.sendVideo).toHaveBeenCalledOnce();
    expect(telegram.sendVideo).toHaveBeenCalledWith("1", "stored-converter-file", expect.anything());
  });

  it("requeues safely after a transient read error following the SQL claim", async () => {
    db.conversionRequest.findUnique.mockRejectedValueOnce(new Error("temporary database error"));
    processDownloadQueue();
    await waitForDownloadQueue();
    expect(db.conversionRequest.update).toHaveBeenCalledWith({ where: { id: "request-1" }, data: { status: "pending" } });
    processDownloadQueue();
    await waitForDownloadQueue();
    expect(telegram.sendVideo).toHaveBeenCalledWith("1", "converter-file", expect.anything());
  });

  it("retains recovery after both the claimed-row read and the requeue write fail", async () => {
    db.conversionRequest.findUnique.mockRejectedValueOnce(new Error("database unavailable"));
    db.conversionRequest.update.mockRejectedValueOnce(new Error("database unavailable"));
    processDownloadQueue();
    await waitForDownloadQueue();
    processDownloadQueue();
    await waitForDownloadQueue();
    expect(telegram.sendVideo).toHaveBeenCalledWith("1", "converter-file", expect.anything());
  });

  it("persists an unknown delivery after the database returns without resending video", async () => {
    let unavailable = true;
    db.conversionRequest.update.mockImplementation(async ({ data }: { data: { status: string } }) => {
      if (unavailable && (data.status === "done" || data.status === "uncertain")) throw new Error("database unavailable");
      return {};
    });
    processDownloadQueue();
    await waitForDownloadQueue();
    expect(telegram.sendVideo).toHaveBeenCalledTimes(2);
    unavailable = false;
    processDownloadQueue();
    await waitForDownloadQueue();
    expect(telegram.sendVideo).toHaveBeenCalledTimes(2);
    expect(telegram.sendMessage).toHaveBeenCalledWith("1", expect.stringContaining("Результат отправки неизвестен"));
    expect(db.conversionRequest.update).toHaveBeenCalledWith({ where: { id: "request-1" }, data: expect.objectContaining({ status: "uncertain" }) });
  });

  it("does not use the archive's YouTube cookies or yt-dlp user configuration", async () => {
    db.conversionRequest.findUnique.mockResolvedValue({ ...(await db.conversionRequest.findUnique()), originalUrl: "https://youtu.be/Fixture" });
    const originalExists = fs.existsSync;
    const exists = vi.spyOn(fs, "existsSync").mockImplementation((file) => String(file) === "/run/private/youtube-cookies.txt" || originalExists(file));
    const binDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "converter-test-bin-"));
    const previousPath = process.env.PATH;
    await fs.promises.writeFile(path.join(binDir, "yt-dlp"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--cookies") || !args.includes("--ignore-config")) process.exit(1);
if (args.includes("--dump-json")) process.stdout.write(JSON.stringify({ duration: 12, filesize: 13 }));
else {
  const template = args[args.indexOf("--output") + 1];
  fs.writeFileSync(template.replace("%(id)s", "fixture").replace("%(ext)s", "mp4"), "fixture-video");
}
`, { mode: 0o755 });
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    try {
      processDownloadQueue();
      await waitForDownloadQueue();
      expect(telegram.sendVideo).toHaveBeenCalledWith("1", "converter-file", expect.anything());
    } finally {
      exists.mockRestore();
      process.env.PATH = previousPath;
      await fs.promises.rm(binDir, { recursive: true, force: true });
    }
  });
});
