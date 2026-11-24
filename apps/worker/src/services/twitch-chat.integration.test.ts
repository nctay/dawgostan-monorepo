import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const databaseUrl = process.env.TWITCH_CHAT_TEST_DATABASE_URL;
const { queries, on } = vi.hoisted(() => ({ queries: [] as string[], on: vi.fn() }));
vi.mock("tmi.js", () => ({
  default: {
    Client: class {
      on = on;
      connect = vi.fn();
    },
  },
}));
vi.mock("../prisma.js", () => {
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl, log: [{ emit: "event", level: "query" }] });
  prisma.$on("query", ({ query }) => queries.push(query));
  return { prisma };
});

describe.skipIf(!databaseUrl)("chat ingestion on PostgreSQL", () => {
  const login = `chat_test_${randomUUID()}`;
  const urlPrefix = `https://example.com/${login}/`;
  const endedAt = new Date("2026-06-12T10:00:00Z");
  let db: PrismaClient;
  let streamerId: string;
  let sessionId: string;
  let receive: (channel: string, tags: Record<string, string>, text: string, self: boolean) => Promise<void>;

  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", databaseUrl!);
    vi.stubEnv("TWITCH_CHANNELS", login);
    vi.stubEnv("TWITCH_CLIENT_ID", "fixture");
    vi.stubEnv("TWITCH_CLIENT_SECRET", "fixture");
    vi.stubEnv("ALLOW_PRIVATE_MEDIA_HOSTS", "true");
    vi.stubEnv("WTV_CHANNELS", login);
    db = (await import("../prisma.js")).prisma;
    const streamer = await db.streamer.create({
      data: { login, twitchUserId: login, displayName: login },
    });
    streamerId = streamer.id;
    const { ensureChatConnected } = await import("./twitch.js");
    await ensureChatConnected();
    receive = on.mock.calls.find(([event]) => event === "message")![1];
  });

  beforeEach(async () => {
    const session = await db.streamSession.create({
      data: { streamerId, startedAt: new Date(endedAt.getTime() - 3_600_000) },
    });
    sessionId = session.id;
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await db.streamSession.deleteMany({ where: { streamerId } });
    await db.blockedMedia.deleteMany({ where: { normalizedUrl: { startsWith: urlPrefix } } });
    await db.asset.deleteMany({ where: { normalizedUrl: { startsWith: urlPrefix } } });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (streamerId) await db.streamer.delete({ where: { id: streamerId } });
    await db?.$disconnect();
  });

  it("buffers live text in one statement and stops exactly thirty minutes after offline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    async function send(id: string, elapsed: number, text = id, tags: Record<string, string> = {}) {
      vi.setSystemTime(endedAt.getTime() + elapsed);
      queries.length = 0;
      await receive(`#${login}`, { id, ...tags }, text, false);
      return queries.length;
    }

    expect(await send("live", -1, "original", { username: "viewer", "user-id": "42" })).toBe(1);
    expect(await send("live", -1, "updated")).toBe(1);
    await db.streamSession.update({ where: { id: sessionId }, data: { endedAt } });
    const graceMs = 30 * 60 * 1000;
    expect(await send("last", graceMs - 1)).toBe(1);
    expect(await send("boundary", graceMs)).toBe(1);
    expect(await send("late", graceMs + 1, "https://example.com/expired.jpg")).toBe(1);
    await send("live", graceMs + 2, "late replay");
    const messages = await db.twitchChatMessage.findMany({
      where: { streamerId }, orderBy: { postedAt: "asc" },
      select: { twitchMessageId: true, streamSessionId: true, authorLogin: true, authorTwitchId: true, messageText: true, postedAt: true },
    });
    expect(messages).toEqual([
      { twitchMessageId: "live", streamSessionId: sessionId, authorLogin: "viewer", authorTwitchId: "42",
        messageText: "updated", postedAt: new Date(endedAt.getTime() - 1) },
      { twitchMessageId: "last", streamSessionId: sessionId, authorLogin: null, authorTwitchId: null,
        messageText: "last", postedAt: new Date(endedAt.getTime() + graceMs - 1) },
    ]);
    expect(await db.chatPost.count({ where: { streamSessionId: sessionId } })).toBe(0);
  });

  it("expires previously offline w.tv sessions during an outage and after configuration removal", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(+endedAt + 31 * 60_000);
    const removedLogin = `${login}_removed`;
    const previous = await db.streamer.findUniqueOrThrow({ where: { id: streamerId } });
    const removed = await db.streamer.create({ data: { login: removedLogin, twitchUserId: `wtv:${removedLogin}`, displayName: removedLogin } });
    try {
      await db.streamer.update({ where: { id: streamerId }, data: { twitchUserId: `wtv:${login}` } });
      await db.streamSession.update({ where: { id: sessionId }, data: { endedAt } });
      const old = await db.streamSession.create({ data: { streamerId: removed.id, startedAt: new Date(+endedAt - 60_000), endedAt } });
      const sessionIds = [sessionId, old.id];
      for (const id of sessionIds) {
        await db.wtvPendingMessage.create({ data: { sessionId: id, messageId: "pending", sourceUrls: ["https://bit.ly/old"],
          authorName: "viewer", messageText: "https://bit.ly/old", postedAt: endedAt } });
        await db.wtvRedirect.create({ data: { sessionId: id, messageId: "pending", sourceUrl: "https://bit.ly/old", targetUrl: urlPrefix } });
      }
      vi.stubGlobal("fetch", async () => { throw new Error("w.tv unavailable"); });
      await (await import("./wtv.js")).pollWtvStreams();
      expect(await db.streamSession.count({ where: { id: { in: sessionIds }, status: "ended" } })).toBe(2);
      expect(await db.wtvPendingMessage.count({ where: { sessionId: { in: sessionIds } } })).toBe(0);
      expect(await db.wtvRedirect.count({ where: { sessionId: { in: sessionIds } } })).toBe(0);
    } finally {
      await db.streamer.delete({ where: { id: removed.id } });
      await db.streamer.update({ where: { id: streamerId }, data: { twitchUserId: previous.twitchUserId } });
    }
  });

  it.each(["w.tv", "Twitch", "Twitch EventSub"])("keeps one %s session on the second poll after a reconnect", async source => {
    const resumedAt = new Date(+endedAt + 10 * 60_000);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(resumedAt);
    const startedAt = new Date(+endedAt - 3_600_000);
    await db.streamSession.update({ where: { id: sessionId }, data: { twitchStreamId: "previous", endedAt } });
    const stream = { id: "resumed", user_id: login, user_login: login, user_name: login, started_at: resumedAt.toISOString() };
    vi.stubGlobal("fetch", async (input: URL | string) => {
      const { pathname } = new URL(input);
      if (pathname.endsWith("/token")) return Response.json({ access_token: "fixture", expires_in: 3600 });
      if (pathname.endsWith("/users")) return Response.json({ data: [{ id: login, login, display_name: login }] });
      if (pathname.endsWith("/streams")) return Response.json({ data: [stream] });
      if (pathname.includes("/profiles/")) return Response.json({ profile: { userId: login, nickname: login } });
      if (pathname.includes("/channels/")) return Response.json({ channel: { channelId: login, name: login, live: true,
        liveStream: { streamId: stream.id, title: "test", startedAt: resumedAt, state: "started", playbackUrl: "test" } } });
      if (pathname.endsWith("/messages")) return Response.json({ messages: [] });
      throw new Error(`Unexpected fixture request: ${pathname}`);
    });
    const { pollTwitchStreams, handleEventSubMessage } = await import("./twitch.js");
    const poll = source === "w.tv" ? (await import("./wtv.js")).pollWtvStreams : pollTwitchStreams;
    if (source === "Twitch EventSub") {
      await handleEventSubMessage(JSON.stringify({ metadata: { message_type: "notification", subscription_type: "stream.online" },
        payload: { event: { broadcaster_user_id: login, broadcaster_user_login: login, broadcaster_user_name: login,
          id: stream.id, started_at: stream.started_at } } }));
    } else {
      await poll();
    }
    await poll();
    expect(await db.streamSession.findMany({ where: { streamerId }, select: { id: true, startedAt: true, status: true } }))
      .toEqual([{ id: sessionId, startedAt, status: "live" }]);
  });

  it("counts SQL from IRC receipt to queuing a fresh URL", async () => {
    const url = `${urlPrefix}fresh.jpg`;
    queries.length = 0;
    await receive(`#${login}`, { id: "fresh" }, url, false);
    const count = queries.length;
    expect(await db.downloadJob.count({ where: { url } })).toBe(1);
    expect(count).toBe(7);
  });

  it("queues only media from the current w.tv session when the API replays chat history", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(endedAt);
    const { pollWtvStreams } = await import("./wtv.js");
    const oldLink = `https://youtu.be/${login}`;
    const nextStart = new Date(endedAt.getTime() + 31 * 60_000);
    function message(id: string, content: string, createdAt: Date | string) {
      return { messageId: `${login}-${id}`, content, createdAt, type: "MESSAGE", sender: { nickname: "viewer" } };
    }
    const oldMessage = message("old", oldLink, endedAt);
    let messages = [oldMessage];
    let live = true;
    let startedAt = new Date(endedAt.getTime() - 3_600_000);
    vi.stubGlobal("fetch", async (url: URL) => {
      if (url.pathname.includes("/profiles/")) return Response.json({ profile: { userId: login, nickname: login } });
      if (url.pathname.includes("/channels/")) return Response.json({ channel: {
        channelId: login, name: login, live,
        liveStream: { streamId: startedAt.toISOString(), title: "test", startedAt, state: "started", playbackUrl: "test" },
      } });
      if (url.pathname.endsWith("/messages")) return Response.json({ messages });
      throw new Error(`Unexpected fixture request: ${url}`);
    });
    try {
      await db.streamer.update({ where: { id: streamerId }, data: { youtubeDisabledUntil: nextStart } });
      await pollWtvStreams();
      expect(await db.chatPost.count({ where: { streamSessionId: sessionId } })).toBe(0);
      live = false;
      await pollWtvStreams();

      vi.setSystemTime(nextStart);
      live = true;
      startedAt = nextStart;
      const fresh = `${urlPrefix}wtv-current.jpg`;
      const second = `${urlPrefix}wtv-second.jpg`;
      messages = [];
      await pollWtvStreams();
      // A previous worker committed the first URL and stopped before saving the second.
      const { ingestChatMessage } = await import("./twitch.js");
      await ingestChatMessage({ streamerLogin: login, authorName: "viewer", postedAt: nextStart,
        twitchMessageId: `wtv:${login}-current`, messageText: fresh });
      messages = [
        message("current", `${fresh} ${second}`, nextStart),
        message("undated", `${urlPrefix}wtv-undated.jpg`, "unknown"),
        message("unseen", `${urlPrefix}wtv-stale.jpg`, new Date(+nextStart - 1)),
        oldMessage,
      ];
      await pollWtvStreams();
      const posts = await db.chatPost.findMany({ where: { streamSession: { streamerId } }, orderBy: { originalUrl: "asc" },
        select: { originalUrl: true, streamSession: { select: { startedAt: true } }, downloadJobs: { select: { url: true } } },
      });
      expect(posts).toEqual([fresh, second].map(url => ({ originalUrl: url, streamSession: { startedAt: nextStart }, downloadJobs: [{ url }] })));
    } finally {
      await db.asset.deleteMany({ where: { normalizedUrl: oldLink } });
    }
  });

  it.each(["tag", "stored flag"])("restores the original context of a partially archived private w.tv message (%s)", async privacy => {
    const first = `${urlPrefix}first.jpg`;
    const second = `${urlPrefix}second.jpg`;
    const id = `wtv:${login}-partial`;
    const original = `${privacy === "tag" ? "!skip_tg " : ""}original caption ${first} ${second}`;
    await db.chatPost.create({ data: { streamSessionId: sessionId, rawTwitchMessageId: id, twitchMessageId: `${id}:${first}`,
      originalUrl: first, normalizedUrl: first, postedAt: endedAt, authorName: "original", authorTwitchId: "wtv:original",
      messageText: original, skipTelegramPublic: privacy === "stored flag" } });
    const { ingestChatMessage } = await import("./twitch.js");
    await ingestChatMessage({ streamerLogin: login, wtvSessionId: sessionId, twitchMessageId: id, postedAt: new Date(+endedAt + 1_000),
      authorName: "replacement", authorTwitchId: "wtv:other", messageText: `edited caption ${first} ${second}` });
    expect(await db.chatPost.findFirst({ where: { streamSessionId: sessionId, normalizedUrl: second } })).toMatchObject({
      postedAt: endedAt, authorName: "original", authorTwitchId: "wtv:original", messageText: original, skipTelegramPublic: true,
    });
  });

  function wtvPage(messages: () => unknown[], shortLink: (url: URL) => Response = () => new Response(null, { status: 503 })) {
    vi.stubGlobal("fetch", async (url: URL) => {
      if (url.pathname.includes("/profiles/")) return Response.json({ profile: { userId: login, nickname: login } });
      if (url.pathname.includes("/channels/")) return Response.json({ channel: { channelId: login, name: login, live: true,
        liveStream: { streamId: login, startedAt: endedAt, state: "started", playbackUrl: "test" } } });
      if (url.pathname.endsWith("/messages")) return Response.json({ messages: messages() });
      if (url.hostname === "bit.ly") return shortLink(url);
      if (url.href.startsWith(urlPrefix)) return new Response("image");
      throw new Error(`Unexpected fixture request: ${url}`);
    });
  }

  it.each(["archived", "pending"])("keeps a w.tv privacy edit through a 503 and restart (%s message)", async state => {
    const first = `${urlPrefix}first.jpg`;
    const short = "https://bit.ly/edited";
    const added = `${urlPrefix}added.jpg`;
    const messageId = `${login}-privacy-${state}`;
    const id = `wtv:${messageId}`;
    const original = state === "archived" ? first : short;
    if (state === "archived") {
      await db.chatPost.create({ data: { streamSessionId: sessionId, rawTwitchMessageId: id, twitchMessageId: `${id}:${first}`,
        originalUrl: first, normalizedUrl: first, postedAt: endedAt, authorName: "original", messageText: original } });
    } else {
      await db.wtvPendingMessage.create({ data: { sessionId, messageId: id, authorName: "original", postedAt: endedAt,
        messageText: original, sourceUrls: [short] } });
    }
    const edited = { messageId, type: "MESSAGE", content: state === "pending" ? `!skip_tg ${short} ${added}` : `!skip_tg ${short}`, sender: { nickname: "editor" }, createdAt: endedAt };
    let available = false;
    wtvPage(() => available ? [] : [edited], () => available ? Response.redirect(`${urlPrefix}target.jpg`) : new Response(null, { status: 503 }));
    await (await import("./wtv.js")).pollWtvStreams();
    expect(await db.wtvPendingMessage.findUnique({ where: { sessionId_messageId: { sessionId, messageId: id } } }))
      .toMatchObject({ skipTelegramPublic: true, messageText: original });
    available = true;
    vi.resetModules();
    await (await import("./wtv.js")).pollWtvStreams();
    const posts = await db.chatPost.findMany({ where: { streamSessionId: sessionId, rawTwitchMessageId: id } });
    expect(posts.map(post => post.originalUrl).sort()).toEqual([state === "pending" ? added : first, `${urlPrefix}target.jpg`].sort());
    expect(posts.every(post => post.skipTelegramPublic && post.authorName === "original" && post.messageText === original)).toBe(true);
  });

  it("keeps an in-flight w.tv writer private and preserves newer pending URLs", async () => {
    const slow = "https://bit.ly/in-flight", extra = "https://bit.ly/later";
    const messageId = `wtv:${login}-racing`;
    const input = { streamerLogin: login, wtvSessionId: sessionId, twitchMessageId: messageId, authorName: "viewer", postedAt: endedAt };
    const { ingestChatMessage } = await import("./twitch.js");
    let started!: () => void, release!: () => void;
    const fetching = new Promise<void>(resolve => { started = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    let first = true;
    vi.stubGlobal("fetch", async (url: URL) => {
      if (url.href === slow && first) {
        first = false;
        started();
        await wait;
        return Response.redirect(`${urlPrefix}in-flight.jpg`);
      }
      return url.hostname === "bit.ly" ? new Response(null, { status: 503 }) : new Response("image");
    });
    const stale = ingestChatMessage({ ...input, messageText: slow });
    try {
      await fetching;
      await ingestChatMessage({ ...input, messageText: `!skip_tg ${slow} ${extra}` });
    } finally {
      release();
      await stale;
    }
    expect(await db.wtvPendingMessage.findUnique({ where: { sessionId_messageId: { sessionId, messageId } } }))
      .toMatchObject({ skipTelegramPublic: true, sourceUrls: [slow, extra] });
    expect(await db.chatPost.findFirst({ where: { streamSessionId: sessionId, rawTwitchMessageId: messageId } }))
      .toMatchObject({ messageText: slow, skipTelegramPublic: true });
  });

  it("accepts a WTV message ID in only one of two concurrently observed broadcasts", async () => {
    const nextStart = new Date(+endedAt + 1_000);
    const next = await db.streamSession.create({ data: { streamerId, startedAt: nextStart } });
    const messageId = `wtv:${login}-concurrent-sessions`;
    const { ingestChatMessage } = await import("./twitch.js");
    const input = { streamerLogin: login, authorName: "viewer", twitchMessageId: messageId };
    await Promise.all([
      ingestChatMessage({ ...input, postedAt: endedAt, wtvSessionId: sessionId, messageText: `!skip_tg ${urlPrefix}old.jpg` }),
      ingestChatMessage({ ...input, postedAt: nextStart, wtvSessionId: next.id, messageText: `${urlPrefix}new.jpg` }),
    ]);
    const posts = await db.chatPost.findMany({ where: { rawTwitchMessageId: messageId } });
    expect(posts).toHaveLength(1);
    const [post] = posts;
    expect(post!.skipTelegramPublic).toBe(post!.streamSessionId === sessionId);
    expect(await db.downloadJob.count({ where: { chatPost: { rawTwitchMessageId: messageId } } })).toBe(1);
  });

  it("restores missing w.tv URLs before filtering a replayed page", async () => {
    const ids = ["empty", "bot", "stale"];
    const oldSession = await db.streamSession.create({ data: { streamerId, startedAt: new Date(0), status: "ended" } });
    const oldUrl = `${urlPrefix}old.jpg`;
    await db.chatPost.create({ data: { streamSessionId: oldSession.id, rawTwitchMessageId: "wtv:old-replay",
      twitchMessageId: `wtv:old-replay:${oldUrl}`, originalUrl: oldUrl, normalizedUrl: oldUrl, messageText: oldUrl,
      authorName: "original", postedAt: new Date(0) } });
    for (const name of ids) {
      const first = `${urlPrefix}${name}-first.jpg`;
      const raw = `wtv:${login}-${name}`;
      await db.chatPost.create({ data: { streamSessionId: sessionId, rawTwitchMessageId: raw, twitchMessageId: `${raw}:${first}`,
        originalUrl: first, normalizedUrl: first, postedAt: endedAt, authorName: "original",
        messageText: `!skip_tg ${first} ${urlPrefix}${name}-second.jpg` } });
    }
    wtvPage(() => [{ messageId: "old-replay", content: `${urlPrefix}untrusted.jpg`, sender: { nickname: "viewer" }, createdAt: endedAt, type: "MESSAGE" },
      ...ids.map(name => ({ messageId: `${login}-${name}`, type: "MESSAGE",
      content: name === "empty" ? "edited" : `${urlPrefix}untrusted.jpg`,
      sender: { nickname: name === "bot" ? "Nightbot" : "editor" }, createdAt: name === "stale" ? new Date(0) : endedAt }))]);
    await (await import("./wtv.js")).pollWtvStreams();
    const posts = await db.chatPost.findMany({ where: { streamSessionId: sessionId, normalizedUrl: { endsWith: "-second.jpg" } } });
    expect(posts.map(post => post.normalizedUrl).sort()).toEqual(ids.map(id => `${urlPrefix}${id}-second.jpg`).sort());
    expect(posts.every(post => post.skipTelegramPublic && post.authorName === "original" && +post.postedAt === +endedAt)).toBe(true);
    expect(await db.chatPost.count({ where: { normalizedUrl: `${urlPrefix}untrusted.jpg` } })).toBe(0);
  });

  it("ingests a fresh page when an older w.tv retry throws and the next page evicts it", async () => {
    const url = `${urlPrefix}fresh.jpg`;
    await db.wtvPendingMessage.create({ data: { sessionId, messageId: "wtv:broken-retry", authorName: "viewer", postedAt: endedAt,
      messageText: "https://bit.ly/broken", sourceUrls: ["https://bit.ly/broken"] } });
    let fresh = true;
    wtvPage(() => fresh ? [{ messageId: "fresh-once", content: url, sender: { nickname: "viewer" }, type: "MESSAGE", createdAt: endedAt }] : []);
    const failure = vi.spyOn(await import("./wtv-short-links.js"), "resolveWtvRedirect").mockRejectedValueOnce(new Error("old redirect read failed"));
    try {
      await (await import("./wtv.js")).pollWtvStreams();
      fresh = false;
      await (await import("./wtv.js")).pollWtvStreams();
      expect(await db.downloadJob.count({ where: { url } })).toBe(1);
    } finally { failure.mockRestore(); }
  });

  it.each(["a full page of newer messages", "an edited entry with the original ID"])("recovers a w.tv short link after restart and %s", async page => {
    const { pollWtvStreams } = await import("./wtv.js");
    const direct = `${urlPrefix}direct.jpg`;
    const pinned = `${urlPrefix}pinned.jpg`;
    const recovered = `${urlPrefix}recovered.jpg`;
    const neighbour = `${urlPrefix}neighbour.jpg`;
    let destination = pinned;
    let flakyRequests = 0;
    let mutableRequests = 0;
    function message(id: string, content: string) {
      return { messageId: `${login}-${page}-${id}`, content, createdAt: endedAt, type: "MESSAGE", sender: { nickname: "viewer" } };
    }
    const originals = [message("neighbour", neighbour), message("shorts", `https://bit.ly/flaky ${direct} https://bit.ly/mutable`)];
    let messages = originals;
    vi.stubGlobal("fetch", async (url: URL) => {
      if (url.pathname.includes("/profiles/")) return Response.json({ profile: { userId: login, nickname: login } });
      if (url.pathname.includes("/channels/")) return Response.json({ channel: {
        channelId: login, name: login, live: true,
        liveStream: { streamId: login, title: "test", startedAt: endedAt, state: "started", playbackUrl: "test" },
      } });
      if (url.pathname.endsWith("/messages")) return Response.json({ messages });
      if (url.hostname === "bit.ly") {
        if (url.pathname === "/flaky") {
          if (++flakyRequests === 1) return new Response(null, { status: 503 });
          return Response.redirect(recovered);
        }
        mutableRequests++;
        return Response.redirect(destination);
      }
      if (url.href.startsWith(urlPrefix)) return new Response("image");
      throw new Error(`Unexpected fixture request: ${url}`);
    });
    async function jobs() {
      return (await db.downloadJob.findMany({ where: { chatPost: { streamSessionId: sessionId } } })).map(job => job.url).sort();
    }
    await pollWtvStreams();
    expect(await jobs()).toEqual([direct, pinned, neighbour].sort());
    expect(await db.wtvPendingMessage.count({ where: { sessionId } })).toBe(1);
    destination = `${urlPrefix}changed.jpg`;
    messages = Array.from({ length: 100 }, (_, i) => message(`evict-${i}`, "hello"));
    if (page === "an edited entry with the original ID") messages[0] = message("shorts", "edited caption");
    vi.resetModules();
    const restartedPoll = (await import("./wtv.js")).pollWtvStreams;
    await restartedPoll();
    expect(await jobs()).toEqual([direct, pinned, recovered, neighbour].sort());
    expect(await db.wtvPendingMessage.count({ where: { sessionId } })).toBe(0);
    expect(await db.chatPost.findFirst({ where: { streamSessionId: sessionId, normalizedUrl: recovered } }))
      .toMatchObject({ postedAt: endedAt, messageText: originals[1]!.content, authorName: "viewer" });
    messages = originals;
    await restartedPoll();
    expect(await jobs()).toEqual([direct, pinned, recovered, neighbour].sort());
    expect(await db.chatPost.count({ where: { streamSessionId: sessionId } })).toBe(4);
    expect(mutableRequests).toBe(1);
    expect(flakyRequests).toBe(2);
  });

  it("keeps the fifth pending message private when the new page removes its tag and changes its author", async () => {
    let available = false;
    const originals = Array.from({ length: 5 }, (_, i) => ({
      messageId: `${login}-pending-${i}`, content: `!skip_tg https://bit.ly/backlog-${i}`, createdAt: endedAt,
      type: "MESSAGE", sender: { nickname: "original", userId: "author" },
    }));
    let messages = originals;
    vi.stubGlobal("fetch", async (url: URL) => {
      if (url.pathname.includes("/profiles/")) return Response.json({ profile: { userId: login, nickname: login } });
      if (url.pathname.includes("/channels/")) return Response.json({ channel: { channelId: login, name: login, live: true,
        liveStream: { streamId: login, startedAt: endedAt, state: "started", playbackUrl: "test" } } });
      if (url.pathname.endsWith("/messages")) return Response.json({ messages });
      if (url.hostname === "bit.ly") return available ? Response.redirect(`${urlPrefix}${url.pathname.slice(1)}.jpg`) : new Response(null, { status: 503 });
      if (url.href.startsWith(urlPrefix)) return new Response("image");
      throw new Error(`Unexpected fixture request: ${url}`);
    });
    await (await import("./wtv.js")).pollWtvStreams();
    const pending = await db.wtvPendingMessage.findMany({ where: { sessionId }, orderBy: [{ lastAttemptAt: "asc" }, { messageId: "asc" }] });
    expect(pending).toHaveLength(5);
    const fifth = originals.find(message => `wtv:${message.messageId}` === pending[4]!.messageId)!;
    messages = [{ ...fifth, content: fifth.content.replace("!skip_tg ", ""), sender: { nickname: "replacement", userId: "other" } }];
    available = true;
    vi.resetModules();
    const { pollWtvStreams } = await import("./wtv.js");
    await pollWtvStreams();
    expect(await db.chatPost.count({ where: { streamSessionId: sessionId } })).toBe(4);
    await pollWtvStreams();
    expect(await db.chatPost.findFirst({ where: { streamSessionId: sessionId, rawTwitchMessageId: pending[4]!.messageId } }))
      .toMatchObject({ authorName: "original", authorTwitchId: "wtv:author", messageText: fifth.content, postedAt: endedAt, skipTelegramPublic: true });
    expect(await db.wtvPendingMessage.count({ where: { sessionId } })).toBe(0);
  });

  it.each(["page", "retry"])("stops short-link requests on shutdown during a w.tv %s and recovers the page after restart", async phase => {
    const stop = new AbortController();
    let restarted = false;
    const urls = ["https://bit.ly/slow", "https://bit.ly/sibling"];
    const content = `!skip_tg ${urls.join(" ")}`;
    if (phase === "retry") {
      await db.wtvPendingMessage.create({ data: { sessionId, messageId: "wtv:slow", messageText: content, sourceUrls: urls,
        authorName: "viewer", postedAt: endedAt } });
    }
    const page = [
      { messageId: "new", content: `!skip_tg ${urlPrefix}new.jpg`, createdAt: endedAt, sender: { nickname: "viewer" }, type: "MESSAGE" },
      { messageId: "slow", content, createdAt: endedAt, sender: { nickname: "viewer" }, type: "MESSAGE" },
    ];
    const attempts: string[] = [];
    vi.stubGlobal("fetch", async (url: URL, init: RequestInit) => {
      if (url.pathname.includes("/profiles/")) return Response.json({ profile: { userId: login, nickname: login } });
      if (url.pathname.includes("/channels/")) return Response.json({ channel: { channelId: login, name: login, live: true,
        liveStream: { streamId: login, startedAt: endedAt, state: "started", playbackUrl: "test" } } });
      if (url.pathname.endsWith("/messages")) return Response.json({ messages: restarted ? [] : page });
      if (url.hostname === "bit.ly") {
        attempts.push(url.pathname);
        if (!restarted) {
          stop.abort();
          init.signal?.throwIfAborted();
          return new Response(null, { status: 503 });
        }
        return Response.redirect(`${urlPrefix}${url.pathname.slice(1)}.jpg`);
      }
      if (url.href.startsWith(urlPrefix)) return new Response("image");
      throw new Error(`Unexpected fixture request: ${url}`);
    });
    vi.resetModules();
    await (await import("./wtv.js")).pollWtvStreams(stop.signal);
    expect(attempts).toEqual(["/slow"]);
    expect(await db.wtvPendingMessage.count({ where: { sessionId } })).toBe(2);
    restarted = true;
    vi.resetModules();
    await (await import("./wtv.js")).pollWtvStreams();
    expect(attempts).toEqual(["/slow", "/sibling", "/slow"]);
    const posts = await db.chatPost.findMany({ where: { streamSessionId: sessionId }, orderBy: { originalUrl: "asc" } });
    expect(posts.map(post => post.originalUrl)).toEqual(["new", "sibling", "slow"].map(name => `${urlPrefix}${name}.jpg`));
    expect(posts.every(post => post.skipTelegramPublic && post.authorName === "viewer")).toBe(true);
    expect(await db.wtvPendingMessage.count({ where: { sessionId } })).toBe(0);
  });

  it("retries during grace and rejects a retired private ID with a new timestamp after restart", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(endedAt);
    let live = true;
    let startedAt = new Date(+endedAt - 3_600_000);
    let requests = 0;
    let messages = ["grace", "expired"].map(id => ({ messageId: `${login}-${id}`, content: `${id === "expired" ? "!skip_tg " : ""}https://bit.ly/${id}`,
      createdAt: endedAt, type: "MESSAGE", sender: { nickname: "viewer" } }));
    vi.stubGlobal("fetch", async (url: URL) => {
      if (url.pathname.includes("/profiles/")) return Response.json({ profile: { userId: login, nickname: login } });
      if (url.pathname.includes("/channels/")) return Response.json({ channel: { channelId: login, name: login, live,
        liveStream: { streamId: startedAt.toISOString(), startedAt, state: "started", playbackUrl: "test" } } });
      if (url.pathname.endsWith("/messages")) return Response.json({ messages });
      if (url.hostname === "bit.ly") {
        requests++;
        if (url.pathname === "/grace" && !live) return Response.redirect(`${urlPrefix}grace.jpg`);
        return new Response(null, { status: 503 });
      }
      if (url.href.startsWith(urlPrefix)) return new Response("image");
      throw new Error(`Unexpected fixture request: ${url}`);
    });
    const { pollWtvStreams } = await import("./wtv.js");
    await pollWtvStreams();
    expect(await db.wtvPendingMessage.count({ where: { sessionId } })).toBe(2);
    live = false;
    await pollWtvStreams();
    expect(await db.wtvPendingMessage.count({ where: { sessionId } })).toBe(1);
    expect(await db.chatPost.findFirst({ where: { streamSessionId: sessionId, normalizedUrl: `${urlPrefix}grace.jpg` } }))
      .toMatchObject({ postedAt: endedAt });
    expect(requests).toBe(4);
    startedAt = new Date(+endedAt + 31 * 60_000);
    vi.setSystemTime(startedAt);
    messages = [];
    live = true;
    await pollWtvStreams();
    expect(requests).toBe(4);
    expect(await db.wtvPendingMessage.count({ where: { sessionId } })).toBe(0);
    expect(await db.wtvRedirect.count({ where: { sessionId } })).toBe(0);
    expect(await db.chatPost.count({ where: { streamSession: { streamerId } } })).toBe(1);
    vi.resetModules();
    function replay(id: string, name: string) {
      return { messageId: `${login}-${id}`, content: `${urlPrefix}${name}.jpg`, createdAt: startedAt, type: "MESSAGE", sender: { nickname: "editor" } };
    }
    messages = [replay("expired", "leaked"), replay("fresh", "fresh")];
    await (await import("./wtv.js")).pollWtvStreams();
    const posts = await db.chatPost.findMany({
      where: { streamSession: { streamerId }, streamSessionId: { not: sessionId } },
      select: { rawTwitchMessageId: true, skipTelegramPublic: true, downloadJobs: { select: { url: true } } },
    });
    expect(posts).toEqual([{ rawTwitchMessageId: `wtv:${login}-fresh`, skipTelegramPublic: false, downloadJobs: [{ url: `${urlPrefix}fresh.jpg` }] }]);
  });

  it.each(["extended", "direct alias", "single", "ambiguous"])("uses historical w.tv link evidence for a %s message", async scenario => {
    const { ingestChatMessage } = await import("./twitch.js");
    const messageId = `wtv:${login}-legacy-${scenario}`;
    const direct = `${urlPrefix}direct.jpg`;
    const oldTarget = `${urlPrefix}old.jpg`;
    const nextDirect = `${urlPrefix}next.jpg`;
    const pinned = `${urlPrefix}pinned.jpg`;
    const short = "https://bit.ly/first";
    const unknown = scenario === "ambiguous" ? [short, "https://bit.ly/second"] : [short];
    const original = [direct, ...unknown, nextDirect, "https://bit.ly/known"].join(" ");
    const messageText = scenario === "ambiguous" ? original + " https://bit.ly/extra" : original;
    const saved = scenario === "extended" || scenario === "direct alias" ? direct : oldTarget;
    await db.chatPost.create({ data: { streamSessionId: sessionId, rawTwitchMessageId: messageId,
      twitchMessageId: `${messageId}:${saved}`, normalizedUrl: saved, originalUrl: saved, authorName: "viewer",
      messageText: scenario === "extended" ? direct : original, postedAt: endedAt, status: "stored" } });
    await db.wtvRedirect.create({ data: { sessionId, messageId, sourceUrl: "https://bit.ly/known", targetUrl: pinned } });
    const network = vi.fn(async (url: URL) => url.hostname === "bit.ly" ? Response.redirect(`${urlPrefix}resolved${url.pathname}.jpg`) : new Response("image"));
    vi.stubGlobal("fetch", network);
    const input = { streamerLogin: login, twitchMessageId: messageId, authorName: "viewer", messageText, postedAt: endedAt };
    await ingestChatMessage(input);
    await ingestChatMessage(input);
    const posts = await db.chatPost.findMany({ where: { streamSessionId: sessionId }, select: { normalizedUrl: true } });
    const requested = scenario === "extended" ? ["/first"] : scenario === "ambiguous" ? ["/extra"] : [];
    expect(posts.map(post => post.normalizedUrl).sort()).toEqual(
      [...new Set([saved, direct, nextDirect, pinned, ...requested.map(path => `${urlPrefix}resolved${path}.jpg`)])].sort());
    expect(network.mock.calls.filter(([url]) => url.hostname === "bit.ly").map(([url]) => url.pathname)).toEqual(requested);
    if (scenario === "single") expect(await db.wtvRedirect.findFirst({ where: { sessionId, messageId, sourceUrl: short } }))
      .toMatchObject({ targetUrl: oldTarget });
    expect(await db.wtvPendingMessage.count({ where: { sessionId } })).toBe(0);
  });

  it("attaches two simultaneous messages with the same URL to one asset and one job", async () => {
    const url = `${urlPrefix}concurrent.jpg`;
    await Promise.all(["first", "second"].map(id => receive(`#${login}`, { id }, url, false)));
    const jobs = await db.downloadJob.findMany({ where: { url } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe("pending");
    const posts = await db.chatPost.findMany({ where: { streamSessionId: sessionId }, orderBy: { rawTwitchMessageId: "asc" } });
    expect(posts.map(post => [post.rawTwitchMessageId, post.assetId])).toEqual([
      ["first", jobs[0]!.assetId], ["second", jobs[0]!.assetId],
    ]);
    expect(jobs[0]!.assetId).toBeTruthy();
  });

  it.each(["stored", "failed"] as const)("does not strand a post joining a job that is becoming %s", async outcome => {
    const { failDownload, markStoredReferences } = await import("./download-references.js");
    const { saveChatMediaPost } = await import("./chat-media-post.js");
    const url = `${urlPrefix}joining.jpg`;
    const input = { streamSessionId: sessionId, originalUrl: url, normalizedUrl: url, messageText: url, authorName: login, postedAt: endedAt };
    await saveChatMediaPost({ ...input, twitchMessageId: `${login}-first` });
    const job = await db.downloadJob.findFirstOrThrow({ where: { url } });
    const canonical = await db.asset.create({ data: { originalUrl: `${urlPrefix}canonical.jpg`, normalizedUrl: `${urlPrefix}canonical.jpg`, status: "stored" } });
    let finishing: Promise<void> | undefined;
    let joining: ReturnType<typeof saveChatMediaPost> | undefined;
    try {
      await db.$transaction(async tx => {
        const [blocker] = await tx.$queryRaw<[{ pid: number }]>`SELECT pg_backend_pid() AS pid FROM download_jobs WHERE id = ${job.id} FOR UPDATE`;
        async function waitingOn(pid: number) {
          const [waiter] = await db.$queryRaw<{ pid: number }[]>`SELECT pid FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid)) LIMIT 1`;
          return waiter?.pid;
        }
        finishing = outcome === "stored"
          ? markStoredReferences(canonical.id, url, job.id, job.chatPostId, job.assetId)
          : failDownload(job.id, job.chatPostId, url, job.assetId, "fixture");
        const finisher = await vi.waitUntil(() => waitingOn(blocker.pid));
        joining = saveChatMediaPost({ ...input, twitchMessageId: `${login}-second` });
        await vi.waitUntil(() => waitingOn(finisher!));
      });
    } finally {
      await Promise.all([finishing, joining]);
    }
    const posts = await db.chatPost.findMany({ where: { normalizedUrl: url }, orderBy: { twitchMessageId: "asc" } });
    const jobs = await db.downloadJob.findMany({ where: { url } });
    if (outcome === "stored") {
      expect(posts.map(p => [p.status, p.assetId])).toEqual([["stored", canonical.id], ["stored", canonical.id]]);
      expect(jobs.map(j => j.status)).toEqual(["done"]);
    } else {
      expect(posts.map(p => p.status)).toEqual(["failed", "pending"]);
      expect(jobs.map(j => j.status).sort()).toEqual(["failed", "pending"]);
    }
  });

  it("keeps VOD media tagged !skip_tg private, including a tag attached to its URL", async () => {
    const url = `${urlPrefix}private.jpg`;
    vi.stubEnv("RECOVERY_VOD_ID", login);
    vi.stubEnv("RECOVERY_FROM", endedAt.toISOString());
    vi.stubEnv("RECOVERY_TO", new Date(+endedAt + 1000).toISOString());
    vi.stubEnv("RECOVERY_DRY_RUN", "false");
    const wwwUrl = `www.example.com/${login}/private.jpg`;
    const texts = [`!skip_tg${url}`, `!skip_tg${wwwUrl}`];
    vi.stubGlobal("fetch", async () => Response.json([{ data: { video: {
      createdAt: endedAt, owner: { id: login, login, displayName: login },
      comments: { edges: texts.map((text, i) => ({ node: { id: `private-${i}`, createdAt: endedAt, commenter: { login: "viewer" },
        message: { fragments: [{ text }] } } })) },
    } } }]));
    try {
      await import("../scripts/recover-vod-chat.js");
      for (const normalizedUrl of [url, `https://${wwwUrl}`]) {
        const post = await db.chatPost.findFirstOrThrow({ where: { normalizedUrl }, include: { downloadJobs: true } });
        expect(post.skipTelegramPublic).toBe(true);
        expect(post.downloadJobs).toHaveLength(1);
      }
    } finally {
      await db.asset.deleteMany({ where: { normalizedUrl: `https://${wwwUrl}` } });
    }
  });

  it("backfills legacy VOD privacy using both ID formats and the tag parser's whitespace", async () => {
    const sql = await readFile(new URL("../../../../prisma/migrations/000014_restore_vod_privacy/migration.sql", import.meta.url), "utf8");
    await db.$transaction(async tx => {
      await tx.$executeRaw`CREATE TEMP TABLE chat_posts (
        id INT, "twitchMessageId" TEXT, "rawTwitchMessageId" TEXT, "messageText" TEXT, "skipTelegramPublic" BOOLEAN DEFAULT FALSE
      ) ON COMMIT DROP`;
      await tx.$executeRaw`INSERT INTO chat_posts (id, "twitchMessageId", "rawTwitchMessageId", "messageText") VALUES
        (1, 'vod:legacy', NULL, '!SKIP_TGwww.example.com/a.jpg'), (2, NULL, 'vod:raw', ${"!skip_tg\u00a0private"}),
        (3, 'vod:bom', NULL, ${"!skip_tg\ufeffprivate"}), (4, 'vod:no', NULL, '!skip_tg_extra'),
        (5, 'irc:id', NULL, '!skip_tg'), (6, 'vod:attached', NULL, '!skip_tghttps://example.com/a.jpg')`;
      await tx.$executeRawUnsafe(sql);
      const tagged = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM chat_posts WHERE "skipTelegramPublic" ORDER BY id`;
      expect(tagged.map(row => row.id)).toEqual([1, 2, 3, 6]);
    });
  });

  it("reuses a running job and creates one new attempt after a terminal failure", async () => {
    const url = `${urlPrefix}retry.jpg`;
    await receive(`#${login}`, { id: "initial" }, url, false);
    const job = await db.downloadJob.findFirstOrThrow({ where: { url } });
    await db.downloadJob.update({ where: { id: job.id }, data: { status: "running" } });
    await receive(`#${login}`, { id: "running" }, url, false);
    expect(await db.downloadJob.count({ where: { url } })).toBe(1);

    const { failDownload } = await import("./download-references.js");
    await failDownload(job.id, job.chatPostId, url, job.assetId, "fixture");
    await Promise.all(["retry1", "retry2"].map(id => receive(`#${login}`, { id }, url, false)));
    expect(await db.downloadJob.count({ where: { url, status: "pending" } })).toBe(1);
    expect(await db.downloadJob.count({ where: { url, status: "failed" } })).toBe(1);
    expect(await db.chatPost.count({ where: { streamSessionId: sessionId, assetId: job.assetId } })).toBe(4);
    expect((await db.asset.findUniqueOrThrow({ where: { normalizedUrl: url } })).status).toBe("pending");
    // Interrupted retries from older workers may still have a failed asset.
    await db.downloadJob.updateMany({ where: { url, status: "pending" }, data: { status: "running" } });
    await db.asset.update({ where: { normalizedUrl: url }, data: { status: "failed" } });
    await (await import("./downloader.js")).recoverInterruptedDownloadJobs();
    expect(await db.downloadJob.count({ where: { url, status: "pending" } })).toBe(1);
  });

  it("preserves blocked and stored posts and ignores replayed message IDs", async () => {
    const canonical = `${urlPrefix}stored.jpg`;
    const alias = `${urlPrefix}alias.jpg`;
    const blocked = `${urlPrefix}blocked.jpg`;
    const fresh = `${urlPrefix}next.jpg`;
    const asset = await db.asset.create({ data: { normalizedUrl: canonical, originalUrl: canonical, status: "stored" } });
    await db.chatPost.create({ data: {
      streamSessionId: sessionId, assetId: asset.id, normalizedUrl: alias, originalUrl: alias,
      status: "stored", authorName: "earlier", messageText: alias, postedAt: new Date(),
    } });
    await db.blockedMedia.create({ data: { normalizedUrl: blocked, reason: "fixture" } });
    const text = [blocked, canonical, alias, fresh].join(" ");
    await Promise.all([1, 2].map(() => receive(`#${login}`, { id: "replay" }, text, false)));
    const posts = await db.chatPost.findMany({ where: { streamSessionId: sessionId, rawTwitchMessageId: "replay" } });
    expect(posts).toHaveLength(4);
    expect(posts).toEqual(expect.arrayContaining([
      expect.objectContaining({ normalizedUrl: blocked, status: "blocked", assetId: null }),
      expect.objectContaining({ normalizedUrl: canonical, status: "stored", assetId: asset.id }),
      expect.objectContaining({ normalizedUrl: alias, status: "stored", assetId: asset.id }),
    ]));
    const jobs = await db.downloadJob.findMany({ where: { chatPost: { streamSessionId: sessionId } } });
    expect(jobs.map(job => job.url)).toEqual([fresh]);
  });
});
