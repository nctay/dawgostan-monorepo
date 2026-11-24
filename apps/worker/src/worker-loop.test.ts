import { afterEach, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({
  channels: ["slow", "fast", "third", "fourth", "fifth", "sixth"],
  download: vi.fn(), recover: vi.fn(), drain: vi.fn(), disconnect: vi.fn(), twitch: vi.fn(), stopTwitch: vi.fn(),
}));
vi.mock("./env.js", () => ({ wtvChannels: fixtures.channels, twitchChannels: [] }));
vi.mock("./prisma.js", () => ({ prisma: {
  $disconnect: fixtures.disconnect,
  streamer: { upsert: async () => ({ id: "streamer" }) },
  streamSession: { findFirst: async () => null, create: async () => ({ id: "session" }), updateMany: async () => ({ count: 0 }) },
  chatPost: { findMany: async () => [] },
  wtvPendingMessage: { findMany: async () => [], deleteMany: vi.fn() }, wtvRedirect: { deleteMany: vi.fn() },
} }));
vi.mock("./services/twitch.js", () => ({
  pollTwitchStreams: fixtures.twitch, ensureChatConnected: async () => {}, ensureEventSubConnected: vi.fn(), cleanupExpiredChatMessages: async () => 0,
  stopTwitchConnections: fixtures.stopTwitch,
}));
vi.mock("./services/public-reposts.js", () => ({ processPublicReposts: vi.fn() }));
vi.mock("./services/downloader.js", () => ({
  processDownloadQueue: fixtures.download, recoverInterruptedDownloadJobs: fixtures.recover, waitForDownloadQueue: fixtures.drain,
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("picks up a queued download and polls neighbouring channels while Twitch and one w.tv channel are slow", async () => {
  const { runWorker } = await import("./worker-loop.js");
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const stop = new AbortController();
  const pageTimes: number[] = [];
  const started: number[] = [];
  const slowStarts: number[] = [];
  let ready = false;
  let active = 0;
  let peak = 0;
  fixtures.download.mockImplementation(() => {
    if (ready) started.push(Date.now());
    ready = false;
  });
  fixtures.twitch.mockImplementation(() => new Promise(resolve => setTimeout(resolve, 12_000)));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal("fetch", async (url: URL, init: RequestInit) => {
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const parts = url.pathname.split("/");
    const channel = parts.at(-1)!;
    if (parts.includes("profiles")) {
      peak = Math.max(peak, ++active);
      if (channel === "slow") slowStarts.push(Date.now());
      await new Promise(resolve => setTimeout(resolve, channel === "slow" ? 12_000 : 1));
      active--;
      return Response.json({ profile: { userId: channel, nickname: channel } });
    }
    if (parts.includes("channels")) return Response.json({ channel: { name: channel, channelId: channel, live: true,
      liveStream: { state: "started", playbackUrl: "play", streamId: channel, startedAt: new Date(0) } } });
    if (parts.at(-2) === "fast") {
      pageTimes.push(Date.now());
      // The fixture fills the second page; other pages are empty.
      if (pageTimes.length === 2) return Response.json({ messages: Array.from({ length: 100 }, (_, i) => ({ messageId: String(i), type: "SYSTEM" })) });
    }
    return Response.json({ messages: [] });
  });
  const worker = runWorker(stop.signal);
  try {
    await vi.advanceTimersByTimeAsync(1_000);
    ready = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(started).toEqual([5_000]);
    expect(pageTimes).toEqual([1, 5_002, 10_003]);
    expect(slowStarts).toEqual([0]);
    expect(fixtures.twitch).toHaveBeenCalledTimes(1);
    expect(peak).toBe(4);
    expect(log.mock.calls.flat().filter(line => String(line).includes("channel=fast") && String(line).includes("messages=100/100"))).toHaveLength(1);
    stop.abort();
    expect(fixtures.disconnect).not.toHaveBeenCalled();
  } finally {
    stop.abort();
    await vi.advanceTimersByTimeAsync(20_000);
    await worker;
  }
  expect(fixtures.drain).toHaveBeenCalledOnce();
  expect(fixtures.stopTwitch).toHaveBeenCalledOnce();
  expect(fixtures.disconnect).toHaveBeenCalledOnce();
  expect(slowStarts).toEqual([0]);
});
