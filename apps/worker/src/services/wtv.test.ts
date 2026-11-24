import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock = vi.hoisted(() => ({
  WTV_CHANNELS: "https://w.tv/kingkong_movie/,https://w.tv/mishamedvedka",
}));

const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
  wtvMessageOwner: { findMany: vi.fn(), updateMany: vi.fn() },
  chatPost: { findMany: vi.fn(), updateMany: vi.fn() },
  wtvPendingMessage: { findMany: vi.fn(), updateMany: vi.fn(), createManyAndReturn: vi.fn(), deleteMany: vi.fn() },
  wtvRedirect: { deleteMany: vi.fn() },
  streamer: {
    findFirst: vi.fn(),
    upsert: vi.fn(),
    updateMany: vi.fn(),
  },
  streamSession: {
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
  },
}));

const ingestChatMessageMock = vi.hoisted(() => vi.fn());
const configuredChannels = vi.hoisted(() => ["kingkong_movie"]);

vi.mock("../env.js", () => ({
  env: envMock,
  twitchChannels: [],
  wtvChannels: configuredChannels,
}));

vi.mock("../prisma.js", () => ({
  prisma: prismaMock,
}));

vi.mock("./twitch.js", () => ({
  ingestChatMessage: ingestChatMessageMock,
}));

function message(messageId: string, content: string, nickname = "Viewer", userId = "viewer-1") {
  return { messageId, type: "MESSAGE", content, sender: { userId, nickname }, createdAt: "2026-08-12T19:45:49.276Z" };
}

describe("w.tv polling", () => {
  let messages: ReturnType<typeof message>[];

  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    configuredChannels.splice(1);
    messages = [
      message("msg-1", "look GSS-media1.tenor.com/m/eQ7o2kL7w8YAAAAC/widening-hole.gif"),
      message("msg-2", "look https://example.com/a.jpg ME-6HuFCn8.gif", "Viewer2", "viewer-2"),
      message("msg-3", "https://eblo.id/eLuDq7N", "HokusModerWW", "viewer-3"),
    ];
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
        return jsonResponse({ messages });
      }
      throw new Error(`unexpected url ${href}`);
    }) as typeof fetch;
    prismaMock.streamer.upsert.mockResolvedValue({ id: "streamer-1", login: "kingkong_movie" });
    prismaMock.streamSession.findFirst.mockResolvedValue(null);
    prismaMock.streamSession.create.mockResolvedValue({ id: "session-1" });
    prismaMock.$transaction.mockImplementation(async run => run(prismaMock));
    prismaMock.wtvMessageOwner.findMany.mockImplementation(async ({ where }) => typeof where.sessionId === "string"
      ? where.messageId.in.map((messageId: string) => ({ messageId, skipTelegramPublic: false })) : []);
    prismaMock.chatPost.findMany.mockResolvedValue([]);
    prismaMock.wtvPendingMessage.createManyAndReturn.mockImplementation(async ({ data }) => data);
    prismaMock.wtvPendingMessage.findMany.mockResolvedValue([]);
    prismaMock.streamSession.updateMany.mockResolvedValue({ count: 0 });
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

  it("ingests each new media message once across overlapping pages and repeated IDs", async () => {
    const { pollWtvStreams } = await import("./wtv.js");
    const first = message("first", "https://example.com/a.jpg");
    const second = message("second", "https://example.com/b.jpg");
    messages = [first];
    await pollWtvStreams();
    messages = [second, second, first];
    await pollWtvStreams();
    await pollWtvStreams();

    expect(ingestChatMessageMock.mock.calls.map(([input]) => input.twitchMessageId)).toEqual(["wtv:first", "wtv:second"]);
  });

  it("looks up a page of plain chat in one batch and processes a later edit to a cached ID", async () => {
    const { pollWtvStreams } = await import("./wtv.js");
    messages = Array.from({ length: 100 }, (_, i) => message(String(i), "chat"));
    await pollWtvStreams();
    await pollWtvStreams();
    expect(prismaMock.chatPost.findMany).toHaveBeenCalledOnce();
    expect(ingestChatMessageMock).not.toHaveBeenCalled();
    messages = [message("42", "https://example.com/added.jpg")];
    await pollWtvStreams();
    expect(ingestChatMessageMock).toHaveBeenCalledOnce();
    expect(ingestChatMessageMock.mock.calls[0]![0]).toMatchObject({ twitchMessageId: "wtv:42", messageText: "https://example.com/added.jpg" });
  });

  it("polls a channel configured by nickname and UUID without overlapping session creation", async () => {
    configuredChannels.push("019df007-47ed-7366-b456-4debc5170fcd");
    const { pollWtvStreams } = await import("./wtv.js");
    await pollWtvStreams();
    expect(prismaMock.streamSession.create).toHaveBeenCalledTimes(1);
    expect(ingestChatMessageMock).toHaveBeenCalledTimes(2);
  });

  it.each(["nickname", "UUID", "both"])("lets the other alias observe a reconnect when %s lookups fail", async failure => {
    const id = "019df007-47ed-7366-b456-4debc5170fcd";
    configuredChannels.push(id);
    prismaMock.streamer.findFirst.mockResolvedValue({ login: "kingkong_movie", twitchUserId: `wtv:${id}` });
    const api = global.fetch;
    let release!: () => void;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    let firstChannelRequest = true;
    global.fetch = vi.fn(async (...args: Parameters<typeof fetch>) => {
      const pathname = new URL(String(args[0])).pathname;
      if (pathname.includes("/profiles/") && failure !== "UUID") throw new Error("profile unavailable");
      // Before the nickname resolves, the first /channels request is the UUID lookup.
      if (pathname.includes("/channels/") && firstChannelRequest) {
        firstChannelRequest = false;
        if (failure !== "nickname") throw new Error("channel unavailable");
      }
      await delayed;
      return api(...args);
    });
    const expirations = () => prismaMock.streamSession.updateMany.mock.calls.filter(([query]) =>
      query.data.status === "ended" && query.where.streamer?.twitchUserId === `wtv:${id}`);
    const { pollWtvStreams } = await import("./wtv.js");
    const polling = pollWtvStreams();
    try {
      await new Promise(resolve => setImmediate(resolve));
      expect(expirations()).toHaveLength(failure === "both" ? 1 : 0);
    } finally {
      release();
      await polling;
    }
    expect(expirations()).toHaveLength(1);
    expect(ingestChatMessageMock).toHaveBeenCalledTimes(failure === "both" ? 0 : 2);
  });

  it("keeps polling a single channel every five seconds while cleanup is busy", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const stop = new AbortController();
    const times: number[] = [];
    const api = global.fetch;
    global.fetch = vi.fn((...args: Parameters<typeof fetch>) => {
      if (String(args[0]).includes("/messages?")) times.push(Date.now());
      return api(...args);
    });
    prismaMock.wtvPendingMessage.deleteMany.mockImplementation(() => new Promise(resolve => setTimeout(resolve, 12_000)));
    const { pollWtvStreams } = await import("./wtv.js");
    const polls = pollWtvStreams(stop.signal);
    try {
      await vi.advanceTimersByTimeAsync(11_000);
      expect(times).toEqual([0, 5_000, 10_000]);
      expect(prismaMock.wtvPendingMessage.deleteMany).toHaveBeenCalledOnce();
    } finally {
      stop.abort();
      await vi.advanceTimersByTimeAsync(12_000);
      await polls;
      vi.useRealTimers();
    }
  });

  it.each(["outage", "reconnect"])("handles staggered nickname and UUID timeouts during %s", async scenario => {
    const id = "019df007-47ed-7366-b456-4debc5170fcd";
    const login = configuredChannels[0]!;
    configuredChannels.push(id);
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const stop = new AbortController();
    const starts: number[][] = [[], []];
    const graceMs = 30 * 60_000;
    let twitchStreamId = "wtv:before";
    let endedAt: Date | null = new Date(12_000 - graceMs);
    let status = "live";
    let pending = true;
    global.fetch = vi.fn(async (input: URL) => {
      const nickname = input.pathname.includes("/profiles/");
      if (scenario === "reconnect" && !nickname && Date.now() >= 20_000) {
        if (input.pathname.includes("/messages")) return Response.json({ messages: [] });
        if (Date.now() === 20_000) await new Promise(resolve => setTimeout(resolve, 12_000));
        return Response.json({ channel: { channelId: id, name: login, live: true,
          liveStream: { streamId: "resumed", startedAt: new Date(11_000), state: "started", playbackUrl: "play" } } });
      }
      const attempts = starts[nickname ? 0 : 1]!;
      attempts.push(Date.now());
      await new Promise(resolve => setTimeout(resolve, nickname && attempts.length === 1 ? 5_000 : 15_000));
      throw new Error("w.tv unavailable");
    }) as typeof fetch;
    prismaMock.streamer.findFirst.mockResolvedValue({ login, twitchUserId: `wtv:${id}` });
    prismaMock.streamSession.findFirst.mockImplementation(async () => status === "live"
      ? { id: "original", twitchStreamId, startedAt: new Date(-graceMs), endedAt } : null);
    prismaMock.streamSession.update.mockImplementation(async ({ data }) => {
      twitchStreamId = data.twitchStreamId;
      endedAt = null;
    });
    prismaMock.streamSession.updateMany.mockImplementation(async ({ where, data }) => {
      if (where.streamer?.twitchUserId === `wtv:${id}` && data.status === "ended") {
        // The UUID resolves while the nickname's earlier failure is still committing.
        if (scenario === "reconnect" && Date.now() === 25_000) await new Promise(resolve => setTimeout(resolve, 10_000));
        if (endedAt && endedAt < where.endedAt.lt) status = "ended";
      }
      return { count: 0 };
    });
    prismaMock.wtvPendingMessage.deleteMany.mockImplementation(async ({ where }) => {
      if (where.session?.status === status) pending = false;
    });
    const { pollWtvStreams } = await import("./wtv.js");
    const polling = pollWtvStreams(stop.signal);
    try {
      if (scenario === "outage") {
        await vi.advanceTimersByTimeAsync(60_000);
        expect(starts[0]).toEqual([0, 10_000, 30_000, 50_000]);
        expect(starts[1]).toEqual([0, 20_000, 40_000, 60_000]);
        expect(status).toBe("ended");
        expect(pending).toBe(false);
      } else {
        await vi.advanceTimersByTimeAsync(36_000);
        expect(prismaMock.streamSession.update).toHaveBeenCalledOnce();
        expect(prismaMock.streamSession.create).not.toHaveBeenCalled();
        expect(status).toBe("live");
        expect(pending).toBe(true);
      }
    } finally {
      stop.abort();
      await vi.advanceTimersByTimeAsync(15_000);
      await polling;
      vi.useRealTimers();
    }
  });

  it("keeps an in-grace reconnect when a slower neighbour reports offline after the cutoff", async () => {
    configuredChannels.push("neighbour");
    vi.useFakeTimers();
    vi.setSystemTime(30 * 60_000 - 5_100);
    const stop = new AbortController();
    let checks = 0;
    let status = "live";
    let twitchStreamId = "wtv:before";
    let endedAt: Date | null = new Date(0);
    let releaseUpdate!: () => void;
    const updating = new Promise<void>(resolve => { releaseUpdate = resolve; });
    global.fetch = vi.fn(async (input: URL) => {
      const parts = input.pathname.split("/");
      const channel = parts.at(-1)!;
      if (parts.includes("profiles")) {
        if (channel === "neighbour") await new Promise(resolve => setTimeout(resolve, 6_000));
        return Response.json({ profile: { userId: channel, nickname: channel } });
      }
      if (parts.includes("channels")) {
        const live = channel !== "neighbour" && ++checks > 1;
        return Response.json({ channel: { channelId: channel, name: channel, live,
          liveStream: live && { streamId: "resumed", startedAt: new Date(30 * 60_000 - 100), state: "started", playbackUrl: "play" } } });
      }
      return Response.json({ messages: [] });
    }) as typeof fetch;
    prismaMock.streamSession.findFirst.mockImplementation(async () =>
      status === "live" && { id: "original", twitchStreamId, startedAt: new Date(-60_000), endedAt });
    prismaMock.streamSession.update.mockImplementation(async ({ data }) => {
      await updating;
      twitchStreamId = data.twitchStreamId;
      endedAt = null;
    });
    prismaMock.streamSession.updateMany.mockImplementation(async ({ where, data }) => {
      const applies = !where.streamer || where.streamer.twitchUserId === "wtv:kingkong_movie";
      if (applies && data.status === "ended" && endedAt && endedAt < where.endedAt.lt) status = "ended";
      return { count: 0 };
    });
    const { pollWtvStreams } = await import("./wtv.js");
    const polls = pollWtvStreams(stop.signal);
    try {
      await vi.advanceTimersByTimeAsync(6_100);
      expect(prismaMock.streamSession.update).toHaveBeenCalledOnce();
      expect(status).toBe("live");
      releaseUpdate();
      await vi.advanceTimersByTimeAsync(5_100);
      expect(prismaMock.streamSession.create).not.toHaveBeenCalled();
      expect(prismaMock.wtvPendingMessage.deleteMany).toHaveBeenCalled();
    } finally {
      releaseUpdate();
      stop.abort();
      await vi.advanceTimersByTimeAsync(10_000);
      await polls;
      vi.useRealTimers();
    }
  });

  it("retries a stalled channel after its API deadline", async () => {
    const { pollWtvStreams } = await import("./wtv.js");
    const api = global.fetch;
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
    try {
      const fetch = vi.fn(api).mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      }));
      global.fetch = fetch;
      const stalled = pollWtvStreams();
      expect(timeout).toHaveBeenCalledWith(15_000);
      deadline.abort(new Error("w.tv request timed out"));
      await stalled;
      expect(ingestChatMessageMock).not.toHaveBeenCalled();
      await pollWtvStreams();
      expect(ingestChatMessageMock).toHaveBeenCalledTimes(2);
    } finally {
      global.fetch = api;
      timeout.mockRestore();
    }
  });

  it.each(["live page", "offline retry"])("lets the fifth channel start after one deadline with four slow channels (%s)", async phase => {
    configuredChannels.push("two", "three", "four", "five");
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const timer = new AbortController();
      setTimeout(() => timer.abort(), ms);
      return timer.signal;
    });
    const starts: [string, number][] = [];
    global.fetch = vi.fn(async (url: URL) => {
      const channel = url.pathname.split("/").at(-1)!;
      if (url.pathname.includes("/profiles/")) {
        starts.push([channel, Date.now()]);
        return Response.json({ profile: { userId: channel, nickname: channel } });
      }
      if (url.pathname.includes("/channels/")) return Response.json({ channel: { channelId: channel, name: channel, live: phase === "live page",
        liveStream: { streamId: channel, startedAt: new Date(0), state: "started", playbackUrl: "test" } } });
      return Response.json({ messages: Array.from({ length: 4 }, (_, i) => message(String(i), "https://bit.ly/slow")) });
    }) as typeof fetch;
    if (phase === "offline retry") prismaMock.wtvPendingMessage.findMany.mockResolvedValue(
      Array.from({ length: 4 }, (_, i) => ({ sessionId: "session", messageId: `wtv:${i}`, authorName: "viewer", messageText: "https://bit.ly/slow", postedAt: new Date() })));
    ingestChatMessageMock.mockImplementation(({ signal }: { signal?: AbortSignal }) => new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 14_000);
      signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    }));
    const { pollWtvStreams } = await import("./wtv.js");
    const polling = pollWtvStreams();
    try {
      await vi.advanceTimersByTimeAsync(15_000);
      expect(starts).toEqual(configuredChannels.map((channel, i) => [channel, i === 4 ? 15_000 : 0]));
    } finally {
      await vi.runAllTimersAsync();
      await polling;
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });

  it("replays the whole message for per-URL deduplication after eviction and restart", async () => {
    const { pollWtvStreams } = await import("./wtv.js");
    const original = message("original", "https://example.com/a.jpg");
    messages = [original];
    await pollWtvStreams();
    messages = Array.from({ length: 100 }, (_, i) => message(`text-${i}`, "hello"));
    await pollWtvStreams();

    messages = [original];
    await pollWtvStreams();
    vi.resetModules();
    await (await import("./wtv.js")).pollWtvStreams();
    expect(ingestChatMessageMock).toHaveBeenCalledTimes(3);
  });

  it("retries a message whose ingestion failed while skipping its completed neighbour", async () => {
    const { pollWtvStreams } = await import("./wtv.js");
    messages = [message("new", "https://example.com/b.jpg"), message("old", "https://example.com/a.jpg")];
    ingestChatMessageMock.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("database unavailable"));
    await pollWtvStreams();
    await pollWtvStreams();
    await pollWtvStreams();
    expect(ingestChatMessageMock.mock.calls.map(([input]) => input.twitchMessageId)).toEqual(["wtv:old", "wtv:new", "wtv:new"]);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
