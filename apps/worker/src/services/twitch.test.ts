import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasSkipTelegramPublicTag, isIgnoredChatAuthor, isIgnoredChatCommand, stripSkipTelegramPublicTag } from "./chat-filter.js";
import { isWithinOfflineGrace } from "./stream-grace.js";

const envMock = vi.hoisted(() => ({
  DATABASE_URL: "postgresql://test/test",
  TWITCH_CLIENT_ID: "client",
  TWITCH_CLIENT_SECRET: "secret",
  TWITCH_EVENTSUB_USER_TOKEN: "user-token",
  TWITCH_EVENTSUB_USER_ID: "9001",
  TWITCH_BOT_USERNAME: "bot",
  TWITCH_BOT_OAUTH: "oauth:test",
  TWITCH_CHANNELS: "streamer",
  WTV_CHANNELS: "",
  TELEGRAM_BOT_TOKEN: "telegram-token",
  TELEGRAM_STORAGE_CHAT_ID: "-100storage",
  TELEGRAM_PUBLIC_CHANNEL_ID: undefined as string | undefined,
  TELEGRAM_DELETED_CHANNEL_ID: "-100deleted" as string | undefined,
  TELEGRAM_PRIVATE_STREAMER_LOGINS: "",
  TWITCH_CHAT_MESSAGE_RETENTION_MINUTES: 120,
  MAX_IMAGE_BYTES: 10,
  MAX_VIDEO_BYTES: 10,
  MAX_DAILY_DOWNLOAD_BYTES: 10,
  MAX_PARALLEL_DOWNLOADS: 1,
  ALLOW_PRIVATE_MEDIA_HOSTS: false,
  ENABLE_PLATFORM_DOWNLOADS: false,
  MAX_PLATFORM_VIDEO_SECONDS: 300,
  PLATFORM_DOWNLOAD_TIMEOUT_MS: 1000,
}));

const privateStreamerLoginsMock = vi.hoisted(() => new Set<string>());
const publishDeletedChatMessageMock = vi.hoisted(() => vi.fn());
const publishStoredTelegramMediaMock = vi.hoisted(() => vi.fn());
const prismaMock = vi.hoisted(() => ({
  streamer: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
    updateMany: vi.fn(),
  },
  streamSession: {
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
  },
  deletedChatMessage: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  twitchChatMessage: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
  chatPost: {
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    findFirst: vi.fn(),
  },
  blockedMedia: {
    findUnique: vi.fn(),
  },
  asset: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    updateMany: vi.fn(),
  },
  downloadJob: {
    findFirst: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock("../env.js", () => ({
  env: envMock,
  privateStreamerLogins: privateStreamerLoginsMock,
}));

vi.mock("../prisma.js", () => ({
  prisma: prismaMock,
}));

vi.mock("./telegram-storage.js", () => ({
  publishDeletedChatMessage: publishDeletedChatMessageMock,
  publishStoredTelegramMedia: publishStoredTelegramMediaMock,
}));

vi.mock("tmi.js", () => ({
  default: { Client: class {} },
}));

vi.mock("ws", () => ({
  default: class {},
}));

describe("twitch stream session grace", () => {
  it("keeps reconnects within thirty minutes in the same session", () => {
    expect(isWithinOfflineGrace(new Date("2026-05-24T10:00:00Z"), new Date("2026-05-24T10:30:00Z"))).toBe(true);
  });

  it("starts a new session after thirty minutes offline", () => {
    expect(isWithinOfflineGrace(new Date("2026-05-24T10:00:00Z"), new Date("2026-05-24T10:30:01Z"))).toBe(false);
  });

  it("does not treat never-ended sessions as grace reconnects", () => {
    expect(isWithinOfflineGrace(null, new Date("2026-05-24T10:00:00Z"))).toBe(false);
  });
});

describe("twitch chat command filtering", () => {
  it("ignores song request commands", () => {
    expect(isIgnoredChatCommand("!sr https://youtu.be/abc")).toBe(true);
    expect(isIgnoredChatCommand("  !SR")).toBe(true);
  });

  it("does not ignore regular messages that merely mention the command", () => {
    expect(isIgnoredChatCommand("look at this https://example.com/a.jpg !sr")).toBe(false);
    expect(isIgnoredChatCommand("!sra https://example.com/a.jpg")).toBe(false);
  });

  it("ignores known bot messages", () => {
    expect(isIgnoredChatAuthor("Nightbot")).toBe(true);
    expect(isIgnoredChatAuthor(" nightbot ")).toBe(true);
    expect(isIgnoredChatAuthor("StreamElements")).toBe(true);
    expect(isIgnoredChatAuthor(" streamelements ")).toBe(true);
    expect(isIgnoredChatAuthor("RealViewer")).toBe(false);
  });

  it("ignores standalone catAsk anywhere in a message", () => {
    for (const message of ["catAsk", "catAsk https://youtu.be/abc", "https://youtu.be/abc catAsk",
      "@ahmad153 catAsk https://youtu.be/JAlQx4H9c5M?si=ZbE2TXACmT7kEPQ6", "look\nCATASK\tplease"]) {
      expect(isIgnoredChatCommand(message)).toBe(true);
    }
    for (const message of ["catAsking https://youtu.be/abc", "mycatAsk https://youtu.be/abc",
      "https://example.com/catAsk", "https://example.com/?q=catAsk"]) {
      expect(isIgnoredChatCommand(message)).toBe(false);
    }
  });

  it("recognizes and removes the public Telegram skip tag", () => {
    expect(hasSkipTelegramPublicTag("look https://example.com/a.jpg !skip_tg now")).toBe(true);
    expect(hasSkipTelegramPublicTag("!skip_tghttps://example.com/a.jpg")).toBe(true);
    expect(hasSkipTelegramPublicTag("https://example.com/a.jpg!skip_tg")).toBe(true);
    expect(hasSkipTelegramPublicTag("!skip_tg_extra https://example.com/a.jpg")).toBe(false);
    expect(stripSkipTelegramPublicTag("look !skip_tg now")).toBe("look now");
    expect(stripSkipTelegramPublicTag("!skip_tghttps://example.com/a.jpg")).toBe("https://example.com/a.jpg");
    expect(stripSkipTelegramPublicTag("https://example.com/a.jpg!skip_tg")).toBe("https://example.com/a.jpg");
  });
});

describe("twitch media ingestion", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    envMock.ALLOW_PRIVATE_MEDIA_HOSTS = false;
  });

  it("stores the public Telegram skip flag with the media post", async () => {
    const { ingestChatMessage } = await import("./twitch.js");
    prismaMock.streamer.findUnique.mockResolvedValue({ id: "streamer-1", login: "streamer" });
    prismaMock.streamSession.findFirst.mockResolvedValue({ id: "session-1", startedAt: new Date("2026-06-12T10:00:00Z") });
    prismaMock.blockedMedia.findUnique.mockResolvedValue(null);
    prismaMock.asset.findUnique.mockResolvedValue(null);
    prismaMock.chatPost.create.mockResolvedValue({ id: "post-1" });
    prismaMock.asset.upsert.mockResolvedValue({ id: "asset-1" });
    prismaMock.downloadJob.findFirst.mockResolvedValue(null);
    prismaMock.downloadJob.create.mockResolvedValue({});

    await ingestChatMessage({
      streamerLogin: "streamer",
      twitchMessageId: "message-1",
      authorName: "Viewer",
      messageText: "!skip_tghttps://example.com/a.jpg",
      postedAt: new Date("2026-06-12T10:04:00Z"),
    });

    expect(prismaMock.chatPost.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ skipTelegramPublic: true }) }),
    );
  });

  it.each(["clck.su", "bit.ly", "tinyurl.com", "clck.ru"])("resolves %s short links before queueing media", async (host) => {
    const { ingestChatMessage } = await import("./twitch.js");
    const resolvedUrl = "https://cdn.discordapp.com/attachments/1/2/image.png?ex=1&hm=2";
    envMock.ALLOW_PRIVATE_MEDIA_HOSTS = true;
    global.fetch = vi.fn(async (input) =>
      String(input).includes(host)
        ? new Response(null, { status: 302, headers: { location: resolvedUrl } })
        : new Response("image", { status: 200, headers: { "content-type": "image/png" } }),
    ) as typeof fetch;
    prismaMock.streamer.findUnique.mockResolvedValue({ id: "streamer-1", login: "streamer" });
    prismaMock.streamSession.findFirst.mockResolvedValue({ id: "session-1", startedAt: new Date("2026-06-12T10:00:00Z") });
    prismaMock.blockedMedia.findUnique.mockResolvedValue(null);
    prismaMock.asset.findUnique.mockResolvedValue(null);
    prismaMock.chatPost.create.mockResolvedValue({ id: "post-1" });
    prismaMock.asset.upsert.mockResolvedValue({ id: "asset-1" });
    prismaMock.downloadJob.findFirst.mockResolvedValue(null);
    prismaMock.downloadJob.create.mockResolvedValue({});

    await ingestChatMessage({
      streamerLogin: "streamer",
      twitchMessageId: "message-1",
      authorName: "Viewer",
      messageText: `look https://${host}/pvnpm`,
      postedAt: new Date("2026-06-12T10:04:00Z"),
    });

    expect(prismaMock.chatPost.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          originalUrl: resolvedUrl,
          normalizedUrl: "https://cdn.discordapp.com/attachments/1/2/image.png",
        }),
      }),
    );
    expect(prismaMock.downloadJob.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ url: resolvedUrl }),
      }),
    );
  });

  it("stops short-link redirect loops without error logging", async () => {
    const loopUrl = "https://bit.ly/bukva_invite";
    const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: loopUrl } }));
    const warnMock = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    envMock.ALLOW_PRIVATE_MEDIA_HOSTS = true;
    global.fetch = fetchMock as typeof fetch;
    const { resolveSupportedMediaUrl } = await import("./redirect-resolver.js");

    expect(await resolveSupportedMediaUrl(loopUrl)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnMock).not.toHaveBeenCalled();
  });
});

describe("twitch EventSub subscriptions", () => {
  beforeEach(() => {
    vi.resetModules();
    envMock.TELEGRAM_DELETED_CHANNEL_ID = "-100deleted";
    envMock.TWITCH_EVENTSUB_USER_TOKEN = "user-token";
    envMock.TWITCH_EVENTSUB_USER_ID = "9001";
    privateStreamerLoginsMock.clear();
    vi.resetAllMocks();
  });

  it("adds channel.chat.message_delete only when deleted channel credentials are configured", async () => {
    const { eventSubSubscriptionSpecs } = await import("./twitch.js");
    expect(eventSubSubscriptionSpecs("1337").map((spec) => spec.type)).toEqual(["channel.chat.message_delete"]);
    expect(eventSubSubscriptionSpecs("1337").at(-1)?.condition).toEqual({ broadcaster_user_id: "1337", user_id: "9001" });

    envMock.TELEGRAM_DELETED_CHANNEL_ID = undefined;
    expect(eventSubSubscriptionSpecs("1337")).toEqual([]);
  });
});

describe("twitch EventSub deleted messages", () => {
  beforeEach(() => {
    vi.resetModules();
    envMock.TELEGRAM_DELETED_CHANNEL_ID = "-100deleted";
    envMock.TWITCH_EVENTSUB_USER_TOKEN = "user-token";
    envMock.TWITCH_EVENTSUB_USER_ID = "9001";
    privateStreamerLoginsMock.clear();
    vi.resetAllMocks();
  });

  it("posts deleted chat messages for active sessions and links stored media", async () => {
    const { handleEventSubMessage } = await import("./twitch.js");
    const streamer = { id: "streamer-1", login: "streamer", displayName: "Streamer" };
    const session = { id: "session-1", startedAt: new Date("2026-06-12T10:00:00Z") };
    const linkedPosts = [
      {
        normalizedUrl: "https://example.com/a.jpg",
        assetId: "asset-1",
        asset: { status: "stored", visibility: "public", telegramChatId: "-100storage", telegramMessageId: 10 },
      },
    ];
    prismaMock.streamer.findUnique.mockResolvedValue(streamer);
    prismaMock.streamSession.findFirst.mockResolvedValue(session);
    prismaMock.deletedChatMessage.findUnique.mockResolvedValue(null);
    prismaMock.deletedChatMessage.create.mockResolvedValue({});
    prismaMock.deletedChatMessage.update.mockResolvedValue({});
    prismaMock.twitchChatMessage.findUnique.mockResolvedValue({
      twitchMessageId: "msg-1",
      authorTwitchId: "42",
      authorLogin: "viewer",
      authorName: "Viewer",
      messageText: "bad link https://example.com/a.jpg",
    });
    prismaMock.chatPost.findMany.mockResolvedValue(linkedPosts);
    publishDeletedChatMessageMock.mockResolvedValue({ telegramChatId: "-100deleted", telegramMessageId: 20 });

    await handleEventSubMessage(chatMessageDeleteEvent());

    expect(prismaMock.deletedChatMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          streamerId: "streamer-1",
          streamSessionId: "session-1",
          twitchMessageId: "msg-1",
          messageText: "bad link https://example.com/a.jpg",
        }),
      }),
    );
    expect(prismaMock.chatPost.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          streamSessionId: "session-1",
          OR: [{ rawTwitchMessageId: "msg-1" }, { twitchMessageId: { startsWith: "msg-1:" } }],
        }),
      }),
    );
    expect(publishDeletedChatMessageMock).toHaveBeenCalledWith(expect.objectContaining({ linkedPosts }));
    expect(publishDeletedChatMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authorName: "Viewer",
        authorLogin: "viewer",
        messageText: "bad link https://example.com/a.jpg",
      }),
    );
    expect(prismaMock.deletedChatMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ telegramMessageId: 20 }),
      }),
    );
  });

  it("ignores non-delete EventSub notifications", async () => {
    const { handleEventSubMessage } = await import("./twitch.js");
    await handleEventSubMessage(
      JSON.stringify({
        metadata: { message_type: "notification", subscription_type: "channel.chat.notification" },
        payload: { event: { broadcaster_user_id: "1337", broadcaster_user_login: "streamer", broadcaster_user_name: "Streamer" } },
      }),
    );
    expect(publishDeletedChatMessageMock).not.toHaveBeenCalled();
    expect(prismaMock.deletedChatMessage.create).not.toHaveBeenCalled();
  });

  it("does not repost duplicate deleted messages", async () => {
    const { handleEventSubMessage } = await import("./twitch.js");
    prismaMock.streamer.findUnique.mockResolvedValue({ id: "streamer-1", login: "streamer" });
    prismaMock.streamSession.findFirst.mockResolvedValue({ id: "session-1", startedAt: new Date("2026-06-12T10:00:00Z") });
    prismaMock.deletedChatMessage.findUnique.mockResolvedValue({ telegramMessageId: 20 });

    await handleEventSubMessage(chatMessageDeleteEvent());

    expect(publishDeletedChatMessageMock).not.toHaveBeenCalled();
    expect(prismaMock.deletedChatMessage.create).not.toHaveBeenCalled();
  });

  it("does not post private streamers or offline sessions", async () => {
    const { handleEventSubMessage } = await import("./twitch.js");
    privateStreamerLoginsMock.add("streamer");
    await handleEventSubMessage(chatMessageDeleteEvent());
    expect(publishDeletedChatMessageMock).not.toHaveBeenCalled();

    privateStreamerLoginsMock.clear();
    prismaMock.streamer.findUnique.mockResolvedValue({ id: "streamer-1", login: "streamer" });
    prismaMock.streamSession.findFirst.mockResolvedValue(null);
    await handleEventSubMessage(chatMessageDeleteEvent());
    expect(publishDeletedChatMessageMock).not.toHaveBeenCalled();
  });

  it("does not post messages tagged to skip Telegram to the deleted channel", async () => {
    const { handleEventSubMessage } = await import("./twitch.js");
    prismaMock.streamer.findUnique.mockResolvedValue({ id: "streamer-1", login: "streamer" });
    prismaMock.streamSession.findFirst.mockResolvedValue({ id: "session-1", startedAt: new Date("2026-06-12T10:00:00Z") });
    prismaMock.deletedChatMessage.findUnique.mockResolvedValue(null);
    prismaMock.deletedChatMessage.create.mockResolvedValue({});
    prismaMock.twitchChatMessage.findUnique.mockResolvedValue({
      twitchMessageId: "msg-1",
      authorName: "Viewer",
      messageText: "https://example.com/a.jpg !skip_tg",
    });
    prismaMock.chatPost.findMany.mockResolvedValue([]);

    await handleEventSubMessage(chatMessageDeleteEvent());

    expect(publishDeletedChatMessageMock).not.toHaveBeenCalled();
    expect(prismaMock.deletedChatMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ skipTelegramPublic: true }) }),
    );
  });

  it("does not post NSFW-hidden media to the deleted channel", async () => {
    const { handleEventSubMessage } = await import("./twitch.js");
    prismaMock.streamer.findUnique.mockResolvedValue({ id: "streamer-1", login: "streamer" });
    prismaMock.streamSession.findFirst.mockResolvedValue({ id: "session-1", startedAt: new Date("2026-06-12T10:00:00Z") });
    prismaMock.deletedChatMessage.findUnique.mockResolvedValue(null);
    prismaMock.deletedChatMessage.create.mockResolvedValue({});
    prismaMock.deletedChatMessage.update.mockResolvedValue({});
    prismaMock.twitchChatMessage.findUnique.mockResolvedValue({
      twitchMessageId: "msg-1",
      authorName: "Viewer",
      messageText: "https://example.com/a.jpg",
    });
    prismaMock.chatPost.findMany.mockResolvedValue([
      {
        skipTelegramPublic: false,
        asset: { status: "stored", visibility: "hidden", telegramChatId: "-100storage", telegramMessageId: 10 },
      },
    ]);

    await handleEventSubMessage(chatMessageDeleteEvent());

    expect(publishDeletedChatMessageMock).not.toHaveBeenCalled();
    expect(prismaMock.deletedChatMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ skipTelegramPublic: true }) }),
    );
  });

  it("records live chat messages for later delete events", async () => {
    const { recordChatMessage } = await import("./twitch.js");
    prismaMock.streamer.findUnique.mockResolvedValue({ id: "streamer-1", login: "streamer" });
    prismaMock.streamSession.findFirst.mockResolvedValue({ id: "session-1", startedAt: new Date("2026-06-12T10:00:00Z") });
    prismaMock.twitchChatMessage.upsert.mockResolvedValue({});

    await recordChatMessage({
      streamerLogin: "streamer",
      twitchMessageId: "msg-1",
      authorTwitchId: "42",
      authorLogin: "viewer",
      authorName: "Viewer",
      messageText: "plain chat text",
      postedAt: new Date("2026-06-12T10:04:00Z"),
    });

    expect(prismaMock.twitchChatMessage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { streamerId_twitchMessageId: { streamerId: "streamer-1", twitchMessageId: "msg-1" } },
        create: expect.objectContaining({ messageText: "plain chat text" }),
      }),
    );
  });

  it("cleans expired chat message buffer using retention minutes", async () => {
    const { cleanupExpiredChatMessages } = await import("./twitch.js");
    envMock.TWITCH_CHAT_MESSAGE_RETENTION_MINUTES = 120;
    prismaMock.twitchChatMessage.deleteMany.mockResolvedValue({ count: 3 });

    const count = await cleanupExpiredChatMessages(new Date("2026-06-12T12:00:00Z"));

    expect(count).toBe(3);
    expect(prismaMock.twitchChatMessage.deleteMany).toHaveBeenCalledWith({
      where: { postedAt: { lt: new Date("2026-06-12T10:00:00Z") } },
    });
  });
});

function chatMessageDeleteEvent() {
  return JSON.stringify({
    metadata: {
      message_type: "notification",
      subscription_type: "channel.chat.message_delete",
      message_timestamp: "2026-06-12T10:05:00Z",
    },
    payload: {
      event: {
        broadcaster_user_id: "1337",
        broadcaster_user_login: "streamer",
        broadcaster_user_name: "Streamer",
        target_user_id: "42",
        target_user_login: "viewer",
        target_user_name: "Viewer",
        message_id: "msg-1",
      },
    },
  });
}
