import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock = vi.hoisted(() => ({
  WTV_CHANNELS: "https://w.tv/kingkong_movie/,https://w.tv/mishamedvedka",
}));

const prismaMock = vi.hoisted(() => ({
  streamer: {
    upsert: vi.fn(),
    updateMany: vi.fn(),
  },
  streamSession: {
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
  },
  chatPost: {
    findFirst: vi.fn(),
  },
}));

const ingestChatMessageMock = vi.hoisted(() => vi.fn());

vi.mock("../env.js", () => ({
  env: envMock,
  wtvChannels: ["kingkong_movie"],
}));

vi.mock("../prisma.js", () => ({
  prisma: prismaMock,
}));

vi.mock("./twitch.js", () => ({
  ingestChatMessage: ingestChatMessageMock,
}));

describe("w.tv polling", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    global.fetch = vi.fn(async (url: URL | string) => {
      const href = String(url);
      if (href.includes("/profiles/by-nickname/kingkong_movie")) {
        return jsonResponse({ profile: { userId: "019df007-47ed-7366-b456-4debc5170fcd", nickname: "KingKong_Movie" } });
      }
      if (href.includes("/channels/019df007-47ed-7366-b456-4debc5170fcd")) {
        return jsonResponse({
          channel: {
            channelId: "019df007-47ed-7366-b456-4debc5170fcd",
            name: "KingKong_Movie",
            live: true,
            liveStreamId: "019ff3b2-dc0a-76cb-a199-297a54109024",
            liveStream: {
              streamId: "019ff3b2-dc0a-76cb-a199-297a54109024",
              title: "Live title",
              state: "started",
              startedAt: "2026-08-12T02:00:13.063Z",
              playbackUrl: "https://example.com/live.m3u8",
            },
          },
        });
      }
      if (href.includes("/chats/019df007-47ed-7366-b456-4debc5170fcd/messages")) {
        return jsonResponse({
          messages: [
            {
              messageId: "msg-1",
              type: "MESSAGE",
              content: "look GSS-media1.tenor.com/m/eQ7o2kL7w8YAAAAC/widening-hole.gif",
              sender: { userId: "viewer-1", nickname: "Viewer" },
              createdAt: "2026-08-12T19:44:49.276Z",
            },
            {
              messageId: "msg-2",
              type: "MESSAGE",
              content: "look https://example.com/a.jpg ME-6HuFCn8.gif",
              sender: { userId: "viewer-2", nickname: "Viewer2" },
              createdAt: "2026-08-12T19:45:49.276Z",
            },
            {
              messageId: "msg-3",
              type: "MESSAGE",
              content: "https://eblo.id/eLuDq7N",
              sender: { userId: "viewer-3", nickname: "HokusModerWW" },
              createdAt: "2026-08-12T19:46:49.276Z",
            },
          ],
        });
      }
      throw new Error(`unexpected url ${href}`);
    }) as typeof fetch;
    prismaMock.streamer.upsert.mockResolvedValue({ id: "streamer-1", login: "kingkong_movie" });
    prismaMock.streamSession.findFirst.mockResolvedValue(null);
    prismaMock.streamSession.create.mockResolvedValue({});
    prismaMock.streamSession.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.chatPost.findFirst.mockResolvedValue(null);
  });

  it("creates a live session and passes w.tv chat media into the common ingestion path", async () => {
    const { pollWtvStreams } = await import("./wtv.js");

    await pollWtvStreams();

    expect(prismaMock.streamer.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          twitchUserId: "wtv:019df007-47ed-7366-b456-4debc5170fcd",
          login: "kingkong_movie",
        }),
      }),
    );
    expect(prismaMock.streamSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          twitchStreamId: "wtv:019ff3b2-dc0a-76cb-a199-297a54109024",
          title: "Live title",
        }),
      }),
    );
    const fetchCalls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(fetchCalls.some(([url]) => String(url).includes("limit=100"))).toBe(true);
    expect(ingestChatMessageMock).toHaveBeenCalledTimes(2);
    expect(ingestChatMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        streamerLogin: "kingkong_movie",
        twitchMessageId: "wtv:msg-2",
        authorTwitchId: "wtv:viewer-2",
        authorName: "Viewer2",
        messageText: "look https://example.com/a.jpg",
      }),
    );
    expect(ingestChatMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        twitchMessageId: "wtv:msg-3",
        authorName: "HokusModerWW",
        messageText: "https://eblo.id/eLuDq7N",
      }),
    );
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
