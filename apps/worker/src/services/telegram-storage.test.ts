import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({ sendPhoto: vi.fn(), sendVideo: vi.fn(), sendAnimation: vi.fn(), copyMessage: vi.fn() }));
const prismaMock = vi.hoisted(() => ({ asset: { updateMany: vi.fn() } }));

vi.mock("grammy", () => ({
  Bot: class {
    api = apiMock;
  },
  InputFile: class {},
}));

vi.mock("../env.js", () => ({
  env: { TELEGRAM_BOT_TOKEN: "token", TELEGRAM_STORAGE_CHAT_ID: "-100storage", TELEGRAM_PUBLIC_CHANNEL_ID: "-100public" },
  privateStreamerLogins: new Set<string>(),
}));

vi.mock("../prisma.js", () => ({ prisma: prismaMock }));

vi.mock("./rate-limit.js", () => ({
  SerialRateLimiter: class {
    schedule<T>(task: () => Promise<T>): Promise<T> {
      return task();
    }
  },
  withTelegramRetry: vi.fn(),
}));

describe("Telegram media spoilers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    apiMock.sendPhoto.mockResolvedValue({
      chat: { id: -100 },
      message_id: 1,
      photo: [{ file_id: "file", file_unique_id: "unique" }],
    });
  });

  it("stores archive media without a Telegram spoiler", async () => {
    const { storeTelegramMedia } = await import("./telegram-storage.js");

    await storeTelegramMedia("/dev/null", "image/jpeg", "image", {
      originalUrl: "https://example.com/image.jpg",
      normalizedUrl: "https://example.com/image.jpg",
      sha256: "hash",
      streamerLogin: "streamer",
      streamerDisplayName: "Streamer",
      streamStartedAt: new Date("2026-09-07T18:00:00Z"),
      streamSessionId: "session",
      assetId: "asset",
      authorName: "Viewer",
      messageText: "https://example.com/image.jpg",
      skipTelegramPublic: false,
    });

    expect(apiMock.sendPhoto.mock.calls[0]?.[2]).not.toHaveProperty("has_spoiler");
  });

  it("accepts a GIF that Telegram stored as a document", async () => {
    apiMock.sendAnimation.mockResolvedValue({
      chat: { id: -100 },
      message_id: 2,
      document: { file_id: "document-file", file_unique_id: "document-unique" },
    });
    const { storeTelegramMedia } = await import("./telegram-storage.js");

    const stored = await storeTelegramMedia("/dev/null", "image/gif", "image", {
      originalUrl: "https://example.com/image.gif",
      normalizedUrl: "https://example.com/image.gif",
      sha256: "hash",
      streamerLogin: "streamer",
      streamerDisplayName: "Streamer",
      streamStartedAt: new Date("2026-09-07T18:00:00Z"),
      streamSessionId: "session",
      assetId: "asset",
      authorName: "Viewer",
      messageText: "https://example.com/image.gif",
      skipTelegramPublic: false,
    });

    expect(stored.telegramFileId).toBe("document-file");
  });

  it("does not publish hidden assets", async () => {
    const { publishStoredTelegramMedia } = await import("./telegram-storage.js");

    await publishStoredTelegramMedia(
      {
        id: "asset",
        visibility: "hidden",
        telegramChatId: "-100storage",
        telegramMessageId: 1,
        telegramFileId: "file",
        telegramIsAnimation: false,
        publicHasSpoiler: false,
        mimeType: "image/jpeg",
        mediaType: "image",
        publicTelegramChatId: null,
        publicTelegramMessageId: null,
      },
      {
        streamerLogin: "streamer",
        streamStartedAt: new Date("2026-09-07T18:00:00Z"),
        authorName: "Viewer",
        messageText: "https://example.com/image.jpg",
        skipTelegramPublic: false,
      },
    );

    expect(apiMock.copyMessage).not.toHaveBeenCalled();
  });

  it("resends a public photo by file_id with a spoiler", async () => {
    const { publishStoredTelegramMedia } = await import("./telegram-storage.js");

    await publishStoredTelegramMedia(
      {
        id: "asset",
        visibility: "public",
        telegramChatId: "-100storage",
        telegramMessageId: 1,
        telegramFileId: "file",
        telegramIsAnimation: false,
        publicHasSpoiler: true,
        mimeType: "image/png",
        mediaType: "image",
        publicTelegramChatId: null,
        publicTelegramMessageId: null,
      },
      {
        streamerLogin: "streamer",
        streamStartedAt: new Date("2026-09-07T18:00:00Z"),
        authorName: "Viewer",
        messageText: "https://example.com/image.png",
        skipTelegramPublic: false,
      },
    );

    expect(apiMock.sendPhoto).toHaveBeenCalledWith(
      "-100public",
      "file",
      expect.objectContaining({ has_spoiler: true }),
    );
    expect(apiMock.copyMessage).not.toHaveBeenCalled();
  });

  it("keeps Unicode letters in the public sender hashtag", async () => {
    apiMock.copyMessage.mockResolvedValue({ message_id: 2 });
    const { publishStoredTelegramMedia } = await import("./telegram-storage.js");

    await publishStoredTelegramMedia(
      {
        id: "asset",
        visibility: "public",
        telegramChatId: "-100storage",
        telegramMessageId: 1,
        telegramFileId: "file",
        telegramIsAnimation: false,
        publicHasSpoiler: false,
        mimeType: "image/jpeg",
        mediaType: "image",
        publicTelegramChatId: null,
        publicTelegramMessageId: null,
      },
      {
        streamerLogin: "streamer",
        streamStartedAt: new Date("2026-09-07T18:00:00Z"),
        authorName: "乃仨尸工丂",
        messageText: "https://example.com/image.jpg",
        skipTelegramPublic: false,
      },
    );

    expect(apiMock.copyMessage).toHaveBeenCalledWith(
      "-100public",
      "-100storage",
      1,
      expect.objectContaining({ caption: expect.stringContaining("#user_乃仨尸工丂") }),
    );
  });
});
