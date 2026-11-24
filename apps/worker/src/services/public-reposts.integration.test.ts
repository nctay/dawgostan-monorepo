import { execFile } from "node:child_process";
import { createServer, type RequestListener } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { Api, type BotConfig, type Context } from "grammy";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ apiRoot: "" }));
vi.mock("grammy", async importOriginal => {
  const original = await importOriginal<typeof import("grammy")>();
  return { ...original, Bot: class extends original.Bot {
    constructor(token: string, options?: BotConfig<Context>) {
      super(token, { ...options, client: { ...options?.client, apiRoot: transport.apiRoot } });
    }
  } };
});

const databaseUrl = process.env.TWITCH_CHAT_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("stored w.tv reposts on PostgreSQL", () => {
  const serve = vi.fn<RequestListener>();
  const server = createServer(serve);
  const schema = `public_reposts_${randomUUID().replaceAll("-", "")}`;
  const fixture = new URL(databaseUrl ?? "postgresql://localhost/test");
  fixture.searchParams.set("schema", schema);
  const prefix = randomUUID();
  const logins = Array.from({ length: 5 }, (_, i) => `viewer_${i}_${prefix}`);
  beforeAll(async () => {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a local TCP port");
    transport.apiRoot = `http://127.0.0.1:${address.port}`;
    vi.stubEnv("DATABASE_URL", fixture.href);
    vi.stubEnv("WTV_CHANNELS", logins.join(","));
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "1:fixture");
    vi.stubEnv("TELEGRAM_PUBLIC_CHANNEL_ID", "-200");
    await promisify(execFile)("pnpm", ["-w", "db:migrate"]);
  }, 30_000);
  afterEach(async () => {
    const { prisma } = await import("../prisma.js");
    await prisma.streamer.deleteMany();
    await prisma.asset.deleteMany();
    serve.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    const { prisma } = await import("../prisma.js");
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await prisma.$disconnect();
    server.closeAllConnections();
    server.close();
    vi.unstubAllEnvs();
  });

  async function queueFile(file: string, publishedAt: Date | null = null) {
    const { prisma } = await import("../prisma.js");
    const url = `https://media.example/${prefix}/${file}.jpg`;
    const streamer = randomUUID();
    return prisma.chatPost.create({ data: {
      streamSession: { create: { startedAt: new Date(), streamer: { create: { login: streamer, displayName: streamer, twitchUserId: streamer } } } },
      authorName: "viewer", messageText: url, originalUrl: url, normalizedUrl: url, postedAt: new Date(), status: "stored", publicRetryAt: new Date(),
      asset: { connectOrCreate: { where: { normalizedUrl: url }, create: { originalUrl: url, normalizedUrl: url,
        status: "stored", telegramChatId: "-100", telegramMessageId: 42,
        publicTelegramPublishedAt: publishedAt, publicTelegramConfirmedAt: publishedAt } } },
    } });
  }

  async function upgradeLegacyAssets() {
    const { prisma } = await import("../prisma.js");
    const migration = await readFile(new URL("../../../../prisma/migrations/000022_public_delivery_confirmation/migration.sql", import.meta.url), "utf8");
    await prisma.$transaction(async tx => {
      await tx.$executeRaw`ALTER TABLE assets DROP COLUMN "publicTelegramConfirmedAt"`;
      for (const statement of migration.split(";").map(sql => sql.trim()).filter(Boolean)) {
        await tx.$executeRawUnsafe(statement);
      }
    });
  }

  it("preserves a w.tv retry when migration runs during a Twitch send rejected with 503", async () => {
    const { prisma } = await import("../prisma.js");
    const { processPublicReposts } = await import("./public-reposts.js");
    const { publishStoredTelegramMedia } = await import("./telegram-storage.js");
    const post = await queueFile("migrating", new Date(Date.now() - 49 * 3600_000));
    await prisma.asset.update({ where: { id: post.assetId! }, data: { publicTelegramMessageId: 200, publicTelegramConfirmedAt: null } });
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: post.assetId! } });
    let reject!: (reason: unknown) => void;
    const rejected = new Promise<never>((_resolve, fail) => { reject = fail; });
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const copy = vi.spyOn(Api.prototype, "copyMessage")
      .mockImplementationOnce(() => { enter(); return rejected; })
      .mockResolvedValue({ message_id: 500 });
    const twitch = publishStoredTelegramMedia(asset, { streamerLogin: "twitch", streamStartedAt: new Date(), authorName: "viewer", messageText: "", skipTelegramPublic: false });
    const outcome = expect(twitch).rejects.toMatchObject({ error_code: 503 });
    try {
      await entered;
      await upgradeLegacyAssets();
    } finally { reject({ error_code: 503 }); await outcome; }
    expect(await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } }))
      .toMatchObject({ publicTelegramPublishedAt: null, publicTelegramConfirmedAt: null });
    expect((await prisma.chatPost.findUniqueOrThrow({ where: { id: post.id } })).publicRetryAt).not.toBeNull();
    await processPublicReposts();
    await processPublicReposts();
    expect(copy).toHaveBeenCalledTimes(2);
    expect(await prisma.chatPost.findUnique({ where: { id: post.id }, include: { asset: true } }))
      .toMatchObject({ publicRetryAt: null, asset: { publicTelegramMessageId: 500, publicTelegramConfirmedAt: expect.any(Date) } });
  }, 15_000);

  it("keeps the legacy 48-hour guard without inferring confirmation from an old message ID", async () => {
    const { prisma } = await import("../prisma.js");
    const { processPublicReposts } = await import("./public-reposts.js");
    const post = await queueFile("legacy", new Date());
    await prisma.asset.update({ where: { id: post.assetId! }, data: { publicTelegramMessageId: 200 } });
    await upgradeLegacyAssets();
    const copy = vi.spyOn(Api.prototype, "copyMessage").mockResolvedValue({ message_id: 501 });
    await processPublicReposts();
    expect(copy).not.toHaveBeenCalled();
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: post.assetId! } })).publicTelegramConfirmedAt).toBeNull();
    expect((await prisma.chatPost.findUniqueOrThrow({ where: { id: post.id } })).publicRetryAt?.getTime()).toBeGreaterThan(Date.now());
    await prisma.asset.update({ where: { id: post.assetId! }, data: { publicTelegramPublishedAt: new Date(Date.now() - 49 * 3600_000) } });
    await prisma.chatPost.update({ where: { id: post.id }, data: { publicRetryAt: new Date() } });
    await processPublicReposts();
    await queueFile("legacy");
    await processPublicReposts();
    expect(copy).toHaveBeenCalledOnce();
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: post.assetId! } })).publicTelegramConfirmedAt).toEqual(expect.any(Date));
    expect(await prisma.chatPost.count({ where: { publicRetryAt: { not: null } } })).toBe(0);
  }, 15_000);

  it.each([503, 429])("retries a real text/plain HTTP %i and sends the stored photo once", async status => {
    const { prisma } = await import("../prisma.js");
    const { processPublicReposts } = await import("./public-reposts.js");
    const post = await queueFile("gateway");
    serve.mockImplementationOnce((_req, res) => res.writeHead(status, { "Content-Type": "text/plain", "Retry-After": "2" }).end("Unavailable"))
      .mockImplementation((_req, res) => res.end(JSON.stringify({ ok: true, result: { message_id: 301 } })));
    await processPublicReposts();
    const where = { id: post.id };
    const retry = await prisma.chatPost.findUniqueOrThrow({ where });
    expect(retry.publicRetryAt?.getTime()).toBeGreaterThan(Date.now());
    expect(retry.publicFileOffset).toBe(0);
    await prisma.chatPost.update({ where, data: { publicRetryAt: new Date() } });
    await processPublicReposts();
    await processPublicReposts();
    expect(serve.mock.calls.map(([req]) => req.url?.split("/").pop())).toEqual(["copyMessage", "copyMessage"]);
    expect(await prisma.chatPost.findUnique({ where, include: { asset: true } })).toMatchObject({
      publicRetryAt: null, asset: { publicTelegramMessageId: 301 },
    });
  });

  it.each([0, 10])("resumes a 49-hour-old reservation at file %i and measures 48 hours from delivery", async offset => {
    const { prisma } = await import("../prisma.js");
    const { processPublicReposts } = await import("./public-reposts.js");
    const reservedAt = new Date(Date.now() - 49 * 3600_000);
    const post = await queueFile("long-retry", reservedAt);
    // An older worker kept the first attempt time on both rows across a retry.
    await prisma.chatPost.update({ where: { id: post.id }, data: {
      publicClaimedAt: reservedAt, publicFileOffset: offset, publicRetryAt: reservedAt,
    } });
    const files = Array.from({ length: 25 }, (_, i) => `photo-${i}`);
    const where = { id: post.assetId! };
    if (offset) await prisma.asset.update({ where, data: { telegramFileIds: files, publicTelegramMessageId: 300 } });
    let lastAcceptedAt = 0;
    async function accept<T>(result: T) {
      await delay(20);
      lastAcceptedAt = Date.now();
      return result;
    }
    const copy = vi.spyOn(Api.prototype, "copyMessage").mockImplementation(() => accept({ message_id: 302 }));
    const sent = { message_id: 302, chat: { id: 11, type: "private" as const, first_name: "fixture" }, date: 0, photo: [] };
    const album = vi.spyOn(Api.prototype, "sendMediaGroup").mockImplementation(() => accept([sent]));
    await processPublicReposts();
    await queueFile("long-retry");
    await processPublicReposts();
    const delivered = await prisma.asset.findUniqueOrThrow({ where });
    expect(lastAcceptedAt).toBeGreaterThan(0);
    expect(delivered.publicTelegramPublishedAt?.getTime()).toBeGreaterThanOrEqual(lastAcceptedAt);
    expect(delivered.publicTelegramMessageId).toBe(offset ? 300 : 302);
    expect(copy).toHaveBeenCalledTimes(offset ? 0 : 1);
    const albumFiles = album.mock.calls.flatMap(([, group]) => group.map(item => item.media));
    expect(albumFiles).toEqual(offset ? files.slice(offset) : []);
    if (!offset) {
      await prisma.asset.update({ where, data: { publicTelegramPublishedAt: new Date(Date.now() - 48 * 3600_000),
        publicTelegramConfirmedAt: new Date(Date.now() - 48 * 3600_000) } });
      await queueFile("long-retry");
      await processPublicReposts();
      expect(copy).toHaveBeenCalledTimes(2);
    }
  }, 15_000);

  it("discards five already published reposts without consuming Telegram slots before a fresh one", async () => {
    const { prisma } = await import("../prisma.js");
    const { processPublicReposts } = await import("./public-reposts.js");
    const { publicChannelSendLimiter } = await import("./telegram-storage.js");
    const recent = new Date();
    for (let i = 0; i < 5; i++) await queueFile("duplicate", recent);
    await queueFile("fresh");
    const slot = vi.spyOn(publicChannelSendLimiter, "schedule");
    const copy = vi.spyOn(Api.prototype, "copyMessage").mockResolvedValue({ message_id: 303 });
    await processPublicReposts();
    expect(copy).toHaveBeenCalledOnce();
    expect(slot).toHaveBeenCalledOnce();
    expect(await prisma.chatPost.count({ where: { publicRetryAt: { not: null } } })).toBe(0);
  }, 15_000);

  it("polls a fifth w.tv channel independently of stored media delivery and resumes only outstanding sends", async () => {
    const url = (login: string) => `https://media.example/${login}.jpg`;
    const { prisma } = await import("../prisma.js");
    const { pollWtvStreams } = await import("./wtv.js");
    const { processPublicReposts } = await import("./public-reposts.js");
    const seen = new Set<string>();
    const startedAt = new Date(Date.now() - 60_000);
    const copy = vi.spyOn(Api.prototype, "copyMessage").mockResolvedValue({ message_id: 100 });
    vi.stubGlobal("fetch", async (input: URL) => {
      const route = input.pathname.split("/");
      const login = route.includes("chats") ? route.at(-2)! : route.at(-1)!;
      if (route.includes("profiles")) return Response.json({ profile: { userId: login, nickname: login } });
      if (route.includes("channels")) return Response.json({ channel: { channelId: login, name: login, live: true,
        liveStream: { streamId: login, startedAt, state: "started", playbackUrl: "fixture" } } });
      seen.add(login);
      return Response.json({ messages: [{ messageId: login, type: "MESSAGE", sender: { nickname: "viewer" }, content: url(login), createdAt: new Date() }] });
    });
    await prisma.asset.createMany({ data: logins.map((login, i) => ({ originalUrl: url(login), normalizedUrl: url(login), status: "stored",
      telegramChatId: "-100", telegramMessageId: i + 1 })) });
    await pollWtvStreams();
    expect(seen).toEqual(new Set(logins));
    expect(copy).not.toHaveBeenCalled();
    const where = { originalUrl: { in: logins.map(url) }, publicRetryAt: { not: null } };
    expect(await prisma.chatPost.count({ where })).toBe(5);

    const stop = new AbortController();
    copy.mockImplementationOnce(async () => { stop.abort(); return { message_id: 101 }; });
    await processPublicReposts(stop.signal);
    expect(copy).toHaveBeenCalledTimes(1);
    expect(await prisma.chatPost.count({ where })).toBe(4);

    const suppressed = await prisma.chatPost.findFirstOrThrow({ where, include: { asset: true } });
    await prisma.chatPost.update({ where: { id: suppressed.id }, data: { skipTelegramPublic: true } });
    await Promise.all([processPublicReposts(), processPublicReposts()]);
    expect(copy).toHaveBeenCalledTimes(4);
    const sourceIds = copy.mock.calls.map(args => args[2]);
    expect(new Set(sourceIds).size).toBe(4);
    expect(sourceIds).not.toContain(suppressed.asset!.telegramMessageId);
    expect(await prisma.chatPost.count({ where })).toBe(0);
  }, 30_000);

  it.each(["same broadcast", "next broadcast"])("applies a fetched privacy edit before resolving other links (%s)", async scenario => {
    const { prisma } = await import("../prisma.js");
    const { pollWtvStreams } = await import("./wtv.js");
    const { processPublicReposts } = await import("./public-reposts.js");
    const login = logins[0]!;
    const id = randomUUID();
    const url = `https://media.example/${id}.jpg`;
    const short = `https://bit.ly/${id}`;
    let streamId = id;
    let startedAt = new Date(Date.now() - 120_000);
    const postedAt = new Date(Date.now() - 60_000);
    const message = (content: string) => ({ messageId: id, type: "MESSAGE", sender: { nickname: "viewer" }, content, createdAt: postedAt });
    let page = [message(url)];
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    let release!: () => void;
    const slow = new Promise<void>(resolve => { release = resolve; });
    vi.stubGlobal("fetch", async (input: URL) => {
      if (input.href === short) { enter(); await slow; return new Response(null, { status: 404 }); }
      if (input.hostname.startsWith("profiles-")) return Response.json({ profile: { userId: login, nickname: login } });
      if (input.hostname.startsWith("streams-")) return Response.json({ channel: { channelId: login, name: login, live: true,
        liveStream: { streamId, startedAt, state: "started", playbackUrl: "fixture" } } });
      return Response.json({ messages: page });
    });
    const copy = vi.spyOn(Api.prototype, "copyMessage").mockRejectedValueOnce({ error_code: 503 }).mockResolvedValue({ message_id: 401 });
    await prisma.asset.create({ data: { originalUrl: url, normalizedUrl: url, status: "stored", telegramChatId: "-100", telegramMessageId: 83 } });
    await pollWtvStreams();
    const original = await prisma.chatPost.findFirstOrThrow({ where: { rawTwitchMessageId: `wtv:${id}` } });
    expect(original.publicRetryAt).not.toBeNull();
    if (scenario === "next broadcast") {
      await processPublicReposts();
      expect(copy).toHaveBeenCalledOnce();
      copy.mockClear();
      await prisma.chatPost.update({ where: { id: original.id }, data: { publicRetryAt: new Date() } });
      await prisma.streamSession.update({ where: { id: original.streamSessionId }, data: { status: "ended", endedAt: new Date() } });
      startedAt = new Date();
      streamId = randomUUID();
    }
    page = [message(`!skip_tg ${url}`)];
    if (scenario === "same broadcast") page.push({ ...message(short), messageId: `${id}-slow` });
    const poll = pollWtvStreams();
    try {
      if (scenario === "same broadcast") await entered;
      else await poll;
      await processPublicReposts();
    } finally { release(); await poll; }
    expect(copy).not.toHaveBeenCalled();
    expect(await prisma.chatPost.findUniqueOrThrow({ where: { id: original.id } }))
      .toMatchObject({ streamSessionId: original.streamSessionId, skipTelegramPublic: true, publicRetryAt: null });
    expect(await prisma.chatPost.count({ where: { rawTwitchMessageId: `wtv:${id}` } })).toBe(1);
  }, 15_000);

  it.each([false, true])("keeps a w.tv retry while a Twitch send is unconfirmed (previous delivery %s)", async previousDelivery => {
    const { prisma } = await import("../prisma.js");
    const { processPublicReposts } = await import("./public-reposts.js");
    const { publishStoredTelegramMedia } = await import("./telegram-storage.js");
    const old = previousDelivery ? new Date(Date.now() - 49 * 3600_000) : null;
    const post = await queueFile("concurrent", old);
    if (old) await prisma.asset.update({ where: { id: post.assetId! }, data: { publicTelegramMessageId: 300 } });
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: post.assetId! } });
    let reject!: (reason: unknown) => void;
    const rejected = new Promise<never>((_resolve, fail) => { reject = fail; });
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const copy = vi.spyOn(Api.prototype, "copyMessage").mockImplementationOnce(() => { enter(); return rejected; }).mockResolvedValue({ message_id: 402 });
    const twitch = publishStoredTelegramMedia(asset, { streamerLogin: "twitch", streamStartedAt: new Date(), authorName: "viewer", messageText: "", skipTelegramPublic: false });
    const outcome = expect(twitch).rejects.toMatchObject({ error_code: 503 });
    try {
      await entered;
      await processPublicReposts();
      expect((await prisma.chatPost.findUniqueOrThrow({ where: { id: post.id } })).publicRetryAt).not.toBeNull();
    } finally { reject({ error_code: 503 }); await outcome; }
    await prisma.chatPost.update({ where: { id: post.id }, data: { publicRetryAt: new Date() } });
    await processPublicReposts();
    await processPublicReposts();
    expect(copy).toHaveBeenCalledTimes(2);
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } })).publicTelegramMessageId).toBe(402);
    expect((await prisma.chatPost.findUniqueOrThrow({ where: { id: post.id } })).publicRetryAt).toBeNull();
  }, 15_000);

  it("resumes an album after an explicit 503 and stops between two Telegram batches", async () => {
    const { prisma } = await import("../prisma.js");
    const { processPublicReposts } = await import("./public-reposts.js");
    const session = await prisma.streamSession.create({ data: {
      streamer: { create: { login: prefix, displayName: prefix, twitchUserId: prefix } }, startedAt: new Date(),
    } });
    const url = `https://media.example/${prefix}/album`;
    const fileIds = Array.from({ length: 18 }, (_, i) => `file-${i}`);
    const post = await prisma.chatPost.create({ data: {
      streamSession: { connect: { id: session.id } }, authorName: "viewer", messageText: url,
      originalUrl: url, normalizedUrl: url, postedAt: new Date(), status: "stored", publicRetryAt: new Date(),
      asset: { create: { originalUrl: url, normalizedUrl: url, status: "stored",
        telegramChatId: "-100", telegramMessageId: 7, telegramFileIds: fileIds } },
    } });
    const sent = { message_id: 101, chat: { id: 11, type: "private" as const, first_name: "fixture" }, date: 0, photo: [] };
    const stop = new AbortController();
    const groups = vi.spyOn(Api.prototype, "sendMediaGroup")
      .mockRejectedValueOnce({ error_code: 503, description: "Unavailable" })
      .mockImplementationOnce(async () => { stop.abort(); return [sent]; })
      .mockResolvedValue([sent]);
    const where = { id: post.id };
    await processPublicReposts();
    const retry = await prisma.chatPost.findUniqueOrThrow({ where });
    expect(retry.publicFileOffset).toBe(0);
    expect(+retry.publicRetryAt!).toBeGreaterThan(Date.now());
    await prisma.chatPost.update({ where, data: { publicRetryAt: new Date() } });
    await processPublicReposts(stop.signal);
    expect(groups).toHaveBeenCalledTimes(2);
    expect((await prisma.chatPost.findUniqueOrThrow({ where })).publicFileOffset).toBe(10);
    await processPublicReposts();
    const delivered = groups.mock.calls.slice(1).flatMap(([, group]) => group.map(item => item.media));
    expect(delivered).toEqual(fileIds);
    expect(await prisma.chatPost.findUnique({ where, include: { asset: true } })).toMatchObject({
      publicRetryAt: null, publicFileOffset: 18, asset: { publicTelegramMessageId: 101 },
    });
  }, 15_000);
});
