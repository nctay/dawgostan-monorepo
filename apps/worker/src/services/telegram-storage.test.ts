import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({ sendPhoto: vi.fn(), sendVideo: vi.fn(), sendAnimation: vi.fn(), sendMediaGroup: vi.fn(), copyMessage: vi.fn() }));
const inputFileMock = vi.hoisted(() => vi.fn());
const prismaMock = vi.hoisted(() => ({ asset: { updateMany: vi.fn(), update: vi.fn() } }));

vi.mock("grammy", () => ({
  Bot: class {
    api = apiMock;
  },
  InputFile: class {
    constructor(...args: unknown[]) {
      inputFileMock(...args);
    }
  },
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
    prismaMock.asset.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.asset.update.mockResolvedValue({});
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

  it("lets grammY open the media file when the request is sent", async () => {
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

    expect(inputFileMock).toHaveBeenCalledWith("/dev/null", "null.jpeg");
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

  it("stores an image album as one Telegram media group", async () => {
    apiMock.sendMediaGroup.mockResolvedValue([
      { chat: { id: -100 }, message_id: 10, photo: [{ file_id: "file-1", file_unique_id: "unique-1" }] },
      { chat: { id: -100 }, message_id: 11, photo: [{ file_id: "file-2", file_unique_id: "unique-2" }] },
    ]);
    const { storeTelegramMediaGroup } = await import("./telegram-storage.js");

    const stored = await storeTelegramMediaGroup(
      [
        { filePath: "/dev/null", mimeType: "image/webp" },
        { filePath: "/dev/null", mimeType: "image/webp" },
      ],
      {
        originalUrl: "https://eblo.id/ATTkHNV",
        normalizedUrl: "https://eblo.id/ATTkHNV",
        sha256: "hash",
        streamerLogin: "streamer",
        streamerDisplayName: "Streamer",
        streamStartedAt: new Date("2026-09-07T18:00:00Z"),
        streamSessionId: "session",
        assetId: "asset",
        authorName: "Viewer",
        messageText: "https://eblo.id/ATTkHNV",
        skipTelegramPublic: false,
      },
    );

    expect(apiMock.sendMediaGroup).toHaveBeenCalledOnce();
    expect(apiMock.sendMediaGroup.mock.calls[0]?.[1]).toHaveLength(2);
    expect(stored.telegramMessageIds).toEqual([10, 11]);
    expect(stored.telegramFileIds).toEqual(["file-1", "file-2"]);
  });

  it("stores 18 photos in two Telegram groups", async () => {
    const { storeTelegramMediaGroup } = await import("./telegram-storage.js");
    const files = Array.from({ length: 18 }, () => ({ filePath: "/dev/null", mimeType: "image/webp" }));
    let nextId = 1;
    apiMock.sendMediaGroup.mockImplementation(async (_chatId, media: unknown[]) => media.map(() => ({
      chat: { id: -100 }, message_id: nextId++, photo: [{ file_id: `file-${nextId}`, file_unique_id: `unique-${nextId}` }],
    })));

    const stored = await storeTelegramMediaGroup(files, {
        originalUrl: "https://eblo.id/album",
        normalizedUrl: "https://eblo.id/album",
        sha256: "hash",
        streamerLogin: "streamer",
        streamerDisplayName: "Streamer",
        streamStartedAt: new Date("2026-09-07T18:00:00Z"),
        streamSessionId: "session",
        assetId: "asset",
        authorName: "Viewer",
        messageText: "https://eblo.id/album",
        skipTelegramPublic: false,
      });
    expect(apiMock.sendMediaGroup).toHaveBeenCalledTimes(2);
    expect(apiMock.sendMediaGroup.mock.calls.map((call) => call[1].length)).toEqual([10, 8]);
    expect(stored.telegramMessageIds).toHaveLength(18);
    expect(stored.telegramFileIds).toHaveLength(18);
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

  it("does not claim a public post for a private streamer", async () => {
    const { privateStreamerLogins } = await import("../env.js");
    const { publishStoredTelegramMedia } = await import("./telegram-storage.js");
    privateStreamerLogins.add("nctay");
    try {
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
          streamerLogin: "nctay",
          streamStartedAt: new Date("2026-10-15T11:00:00Z"),
          authorName: "Viewer",
          messageText: "https://example.com/image.jpg",
          skipTelegramPublic: false,
        },
      );
    } finally {
      privateStreamerLogins.delete("nctay");
    }

    expect(prismaMock.asset.updateMany).not.toHaveBeenCalled();
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

  it("publishes an album as one media group", async () => {
    apiMock.sendMediaGroup.mockResolvedValue([{ message_id: 20 }, { message_id: 21 }]);
    const { publishStoredTelegramMedia } = await import("./telegram-storage.js");

    await publishStoredTelegramMedia(
      {
        id: "asset",
        visibility: "public",
        telegramChatId: "-100storage",
        telegramMessageId: 10,
        telegramMessageIds: [10, 11],
        telegramFileId: "file-1",
        telegramFileIds: ["file-1", "file-2"],
        telegramIsAnimation: false,
        publicHasSpoiler: true,
        mimeType: "image/webp",
        mediaType: "image",
        publicTelegramChatId: null,
        publicTelegramMessageId: null,
      },
      {
        streamerLogin: "streamer",
        streamStartedAt: new Date("2026-09-07T18:00:00Z"),
        authorName: "Viewer",
        messageText: "https://eblo.id/ATTkHNV",
        skipTelegramPublic: false,
      },
    );

    expect(apiMock.sendMediaGroup).toHaveBeenCalledWith(
      "-100public",
      [
        expect.objectContaining({ media: "file-1", has_spoiler: true, caption: expect.stringContaining("#streamer_stream") }),
        expect.objectContaining({ media: "file-2", has_spoiler: true }),
      ],
    );
    expect(apiMock.copyMessage).not.toHaveBeenCalled();
  });

  it("publishes all 18 stored photos in two groups", async () => {
    apiMock.sendMediaGroup.mockImplementation(async (_chatId, media: unknown[]) => media.map((_, index) => ({ message_id: 20 + index })));
    const { publishStoredTelegramMedia } = await import("./telegram-storage.js");

    await publishStoredTelegramMedia(
      {
        id: "asset", visibility: "public", telegramChatId: "-100storage", telegramMessageId: 1,
        telegramFileId: "file-1", telegramFileIds: Array.from({ length: 18 }, (_, index) => `file-${index + 1}`),
        telegramIsAnimation: false, publicHasSpoiler: false, mimeType: "image/jpeg", mediaType: "image",
        publicTelegramChatId: null, publicTelegramMessageId: null,
      },
      {
        streamerLogin: "streamer", streamStartedAt: new Date("2026-09-07T18:00:00Z"),
        authorName: "Viewer", messageText: "https://vt.tiktok.com/example/", skipTelegramPublic: false,
      },
    );

    expect(apiMock.sendMediaGroup.mock.calls.map((call) => call[1].length)).toEqual([10, 8]);
    expect(apiMock.sendMediaGroup.mock.calls[0]?.[1][0]).toHaveProperty("caption", expect.stringContaining("#streamer_stream"));
    expect(apiMock.sendMediaGroup.mock.calls[1]?.[1][0]).toHaveProperty("caption", expect.stringContaining("#streamer_stream"));
    expect(apiMock.sendMediaGroup.mock.calls[1]?.[1][1]).not.toHaveProperty("caption");
  });

  it("includes a caption when the last batch contains one photo", async () => {
    apiMock.sendMediaGroup.mockResolvedValue([{ message_id: 20 }]);
    const { publishStoredTelegramMedia } = await import("./telegram-storage.js");

    await publishStoredTelegramMedia(
      {
        id: "asset", visibility: "public", telegramChatId: "-100storage", telegramMessageId: 1,
        telegramFileId: "file-1", telegramFileIds: Array.from({ length: 11 }, (_, index) => `file-${index + 1}`),
        telegramIsAnimation: false, publicHasSpoiler: false, mimeType: "image/jpeg", mediaType: "image",
        publicTelegramChatId: null, publicTelegramMessageId: null,
      },
      {
        streamerLogin: "streamer", streamStartedAt: new Date("2026-09-07T18:00:00Z"),
        authorName: "Viewer", messageText: "https://vt.tiktok.com/example/", skipTelegramPublic: false,
      },
    );

    expect(apiMock.sendPhoto).toHaveBeenCalledWith("-100public", "file-11", expect.objectContaining({ caption: expect.stringContaining("#streamer_stream") }));
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

  it("publishes an old repeat but suppresses another publication within 48 hours", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    try {
      const { publishStoredTelegramMedia } = await import("./telegram-storage.js");
      const asset = {
        id: "asset",
        visibility: "public" as const,
        telegramChatId: "-100storage",
        telegramMessageId: 1,
        telegramFileId: "file",
        telegramIsAnimation: false,
        publicHasSpoiler: false,
        mimeType: "image/jpeg",
        mediaType: "image",
        publicTelegramChatId: "-100public",
        publicTelegramMessageId: 42,
      };
      const metadata = {
        streamerLogin: "streamer",
        streamStartedAt: new Date("2026-10-15T11:00:00Z"),
        authorName: "Viewer",
        messageText: "https://example.com/image.jpg",
        skipTelegramPublic: false,
      };
      apiMock.copyMessage.mockResolvedValue({ message_id: 43 });
      prismaMock.asset.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

      await publishStoredTelegramMedia(asset, metadata);
      await publishStoredTelegramMedia(asset, metadata);

      expect(prismaMock.asset.updateMany).toHaveBeenCalledWith({
        where: {
          id: "asset",
          visibility: "public",
          OR: [
            { publicTelegramPublishedAt: null },
            { publicTelegramPublishedAt: { lte: new Date("2026-10-13T12:00:00Z") } },
          ],
        },
        data: { publicTelegramPublishedAt: new Date("2026-10-15T12:00:00Z") },
      });
      expect(apiMock.copyMessage).toHaveBeenCalledTimes(1);
      expect(prismaMock.asset.update).toHaveBeenCalledWith({
        where: { id: "asset" },
        data: {
          publicTelegramChatId: "-100public",
          publicTelegramMessageId: 43,
          publicTelegramPublishedAt: new Date("2026-10-15T12:00:00Z"),
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the publication claim when Telegram rejects the send", async () => {
    apiMock.copyMessage.mockRejectedValue(new Error("Telegram unavailable"));
    const { publishStoredTelegramMedia } = await import("./telegram-storage.js");
    const asset = {
      id: "asset",
      visibility: "public" as const,
      telegramChatId: "-100storage",
      telegramMessageId: 1,
      telegramFileId: "file",
      telegramIsAnimation: false,
      publicHasSpoiler: false,
      mimeType: "image/jpeg",
      mediaType: "image",
      publicTelegramChatId: null,
      publicTelegramMessageId: null,
    };

    await expect(publishStoredTelegramMedia(asset, {
      streamerLogin: "streamer",
      streamStartedAt: new Date("2026-10-15T11:00:00Z"),
      authorName: "Viewer",
      messageText: "https://example.com/image.jpg",
      skipTelegramPublic: false,
    })).rejects.toThrow("Telegram unavailable");

    expect(prismaMock.asset.updateMany).toHaveBeenCalledTimes(2);
    expect(prismaMock.asset.updateMany.mock.calls[1]?.[0]).toEqual({
      where: { id: "asset", publicTelegramPublishedAt: expect.any(Date) },
      data: { publicTelegramPublishedAt: null },
    });
    expect(prismaMock.asset.update).not.toHaveBeenCalled();
  });
});
