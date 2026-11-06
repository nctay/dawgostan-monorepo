import { beforeEach, describe, expect, it, vi } from "vitest";
import { GrammyError } from "grammy";

const env = vi.hoisted(() => ({
  TELEGRAM_CONVERTER_BOT_TOKEN: "123456:converter-token", TELEGRAM_CONVERTER_ALLOWED_USERNAMES: "@Alice,bob", TELEGRAM_STORAGE_CHAT_ID: "-100storage",
  ALLOW_PRIVATE_MEDIA_HOSTS: true, ENABLE_PLATFORM_DOWNLOADS: true, MAX_DAILY_DOWNLOAD_BYTES: 10_000_000,
  MAX_VIDEO_BYTES: 1_000_000, MAX_IMAGE_BYTES: 1_000_000, MAX_PLATFORM_VIDEO_SECONDS: 300, MAX_PARALLEL_DOWNLOADS: 1, PLATFORM_DOWNLOAD_TIMEOUT_MS: 10_000,
}));
const db = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  asset: { aggregate: vi.fn() },
  downloadJob: { updateMany: vi.fn() },
  conversionRequest: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findMany: vi.fn(), aggregate: vi.fn() },
  converterUser: { findUnique: vi.fn() },
}));
const telegram = vi.hoisted(() => ({ sendVideo: vi.fn(), sendMessage: vi.fn() }));
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
    db.conversionRequest.update.mockResolvedValue({});
    db.conversionRequest.aggregate.mockResolvedValue({ _sum: { byteSize: 0n } });
    db.asset.aggregate.mockResolvedValue({ _sum: { byteSize: 0n } });
    probe.mockResolvedValue({ width: 720, height: 1280, duration: 12 });
    telegram.sendVideo.mockResolvedValueOnce({ message_id: 101, video: { file_id: "converter-file" } }).mockResolvedValue({ message_id: 102 });
    telegram.sendMessage.mockResolvedValue({ message_id: 103 });
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
});
