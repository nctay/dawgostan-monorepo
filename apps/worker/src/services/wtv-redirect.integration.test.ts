import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const databaseUrl = process.env.TWITCH_CHAT_TEST_DATABASE_URL;
const { lookup, sendPhoto } = vi.hoisted(() => ({ lookup: vi.fn(), sendPhoto: vi.fn() }));
vi.mock("grammy", async importOriginal => ({
  ...await importOriginal<typeof import("grammy")>(),
  Bot: class { api = { sendPhoto }; },
  InputFile: class { constructor(readonly filePath: string) {} },
}));
vi.mock("@dawgostan/media-processing", async importOriginal => ({
  ...await importOriginal<typeof import("@dawgostan/media-processing")>(),
  normalizePhotoForTelegram: async (filePath: string, mimeType: string) => ({ filePath, mimeType }),
}));
vi.mock("node:dns/promises", () => ({ default: { lookup } }));

describe.skipIf(!databaseUrl)("w.tv redirect recovery on PostgreSQL", () => {
  // The queue claims every pending job. Give this suite its own queue, including in parallel CI runs.
  const schema = `wtv_redirect_${randomUUID().replaceAll("-", "")}`;
  const isolatedUrl = new URL(databaseUrl ?? "postgresql://localhost/test");
  isolatedUrl.searchParams.set("schema", schema);
  const db = new PrismaClient({ datasourceUrl: isolatedUrl.href });
  const login = `wtv_redirect_${randomUUID()}`;
  const short = "https://bit.ly/fixture";
  const first = `https://first.example/${login}.jpg`;
  const changed = `https://changed.example/${login}.jpg`;
  let streamerId: string;

  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", isolatedUrl.href);
    await promisify(execFile)("pnpm", ["-w", "db:migrate"]);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:fixture");
    vi.stubEnv("TELEGRAM_STORAGE_CHAT_ID", "-1001");
    vi.stubEnv("TELEGRAM_PUBLIC_CHANNEL_ID", "");
    vi.stubEnv("ALLOW_PRIVATE_MEDIA_HOSTS", "");
    streamerId = (await db.streamer.create({ data: { login, twitchUserId: login, displayName: login } })).id;
  });

  afterEach(async () => {
    await (await import("../prisma.js")).prisma.$disconnect();
    await db.streamSession.deleteMany({ where: { streamerId } });
    await db.asset.deleteMany();
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    if (streamerId) await db.streamer.delete({ where: { id: streamerId } });
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
    vi.unstubAllEnvs();
  });

  const photo = "https://i.postimg.cc/abcd/photo.png";
  const page = "https://postimg.cc/abcd";
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");

  async function startPhotoMessage() {
    const postedAt = new Date();
    const session = await db.streamSession.create({ data: { streamerId, startedAt: postedAt } });
    const message = { streamerLogin: login, authorName: "viewer", twitchMessageId: "wtv:photo", messageText: short, postedAt };
    const received: Buffer[] = [];
    sendPhoto.mockImplementation(async (_chatId: string, input: { filePath: string }) => {
      received.push(await readFile(input.filePath));
      return { chat: { id: -1001 }, message_id: 1, photo: [{ file_id: "file", file_unique_id: "unique" }] };
    });
    lookup.mockResolvedValue([{ address: "93.184.216.34" }]);
    return { message, session, received };
  }

  async function drainQueue() {
    const downloader = await import("./downloader.js");
    downloader.processDownloadQueue();
    await downloader.waitForDownloadQueue();
  }

  it.each(["w.tv 503", "Twitch 503", "existing pin"])("stores the photo after a .jpg redirects to Postimages (%s)", async scenario => {
    const { message, session, received } = await startPhotoMessage();
    if (scenario === "Twitch 503") message.twitchMessageId = "twitch-photo";
    const where = { sessionId_messageId_sourceUrl: { sessionId: session.id, messageId: message.twitchMessageId, sourceUrl: short } };
    if (scenario === "existing pin") await db.wtvRedirect.create({ data: { ...where.sessionId_messageId_sourceUrl, targetUrl: first } });
    let unavailable = true;
    const network = vi.fn(async (input: URL | string, init: RequestInit) => {
      switch (String(input)) {
        case short: return Response.redirect(first);
        case first:
          if (unavailable && new Headers(init.headers).has("range")) return new Response(null, { status: 503 });
          return Response.redirect(page);
        case page: return new Response(`<meta property="og:image" content="${photo}">`, { headers: { "content-type": "text/html" } });
        case photo: return new Response(png, { headers: { "content-type": "image/png" } });
        default: throw new Error("Unexpected fixture URL");
      }
    });
    vi.stubGlobal("fetch", network);
    const { ingestChatMessage } = await import("./twitch.js");
    if (scenario === "w.tv 503") {
      expect(await ingestChatMessage(message)).toBe("retry");
      expect(await db.wtvRedirect.findUnique({ where })).toMatchObject({ targetUrl: first, visitedUrls: [short] });
    }
    if (scenario === "w.tv 503") unavailable = false;
    await ingestChatMessage(message);
    const job = await db.downloadJob.findFirstOrThrow({ where: { chatPost: { streamSessionId: session.id } } });
    expect(job.url).toBe(scenario === "w.tv 503" ? page : first);
    unavailable = false;
    await drainQueue();

    expect(received).toEqual([png]);
    expect(network.mock.calls.filter(([input]) => String(input) === photo)).toHaveLength(1);
    expect(network.mock.calls.filter(([input]) => String(input) === short)).toHaveLength(scenario === "existing pin" ? 0 : 1);
    expect(await db.downloadJob.findFirst({ where: { chatPost: { streamSessionId: session.id } } })).toMatchObject({ status: "done", attempts: 1 });
  });

  it.each(["HEAD", "Range"])("stores a PNG from an extensionless CDN once after a %s probe", async probe => {
    const { message, session, received } = await startPhotoMessage();
    const intermediate = `https://first.example/${login}.png`;
    const cdn = `https://cdn.example/download?id=${login}`;
    let fullDownloads = 0;
    const network = vi.fn(async (input: URL | string, init: RequestInit) => {
      if (String(input) === short) return Response.redirect(intermediate);
      if (String(input) === intermediate) return Response.redirect(cdn);
      if (String(input) !== cdn) throw new Error("Unexpected fixture URL");
      const headers = { "content-type": "image/png; charset=binary" };
      if (init.method === "HEAD") {
        return probe === "HEAD" ? new Response(null, { headers }) : new Response(null, { status: 405 });
      }
      if (probe === "Range" && new Headers(init.headers).get("range") === "bytes=0-0") {
        return new Response(png.subarray(0, 1), { status: 206, headers });
      }
      fullDownloads++;
      return new Response(png, { headers });
    });
    vi.stubGlobal("fetch", network);
    const { ingestChatMessage } = await import("./twitch.js");
    await ingestChatMessage(message);
    expect(await db.downloadJob.findFirst({ where: { chatPost: { streamSessionId: session.id } } })).toMatchObject({ url: cdn });
    expect(fullDownloads).toBe(0);

    await drainQueue();
    expect(received).toEqual([png]);
    expect(fullDownloads).toBe(1);
    expect(await db.wtvRedirect.findFirst({ where: { sessionId: session.id } })).toMatchObject({ targetUrl: cdn, visitedUrls: [] });
  });

  it.each(["public", "private", "cycle", "limit"])("revalidates the observed destination after a DNS outage and restart (%s)", async address => {
    const postedAt = new Date();
    const session = await db.streamSession.create({ data: { streamerId, startedAt: postedAt } });
    const message = { streamerLogin: login, authorName: "viewer", twitchMessageId: "wtv:redirect",
      messageText: short, postedAt };
    let restarted = false;
    lookup.mockImplementation(async (host: string) => {
      if (host === "first.example" && !restarted) throw Object.assign(new Error("temporary DNS failure"), { code: "EAI_AGAIN" });
      return [{ address: host === "first.example" && address === "private" ? "127.0.0.1" : "93.184.216.34" }];
    });
    const hops = address === "limit" ? [1, 2, 3].map(i => `https://intermediate.example/${i}`) : [];
    const route = [short, ...hops, first];
    const network = vi.fn(async (url: URL) => {
      const index = route.indexOf(url.href);
      if (restarted && url.href === short) return Response.redirect(changed);
      if (index >= 0 && index < route.length - 1) return Response.redirect(route[index + 1]!);
      if (address === "cycle") return Response.redirect(short);
      if (address === "limit") return Response.redirect(changed);
      return new Response(null, { headers: { "content-type": "image/jpeg" } });
    });
    vi.stubGlobal("fetch", network);
    const jobs = () => db.downloadJob.findMany({ where: { chatPost: { streamSessionId: session.id } }, select: { url: true } });

    await (await import("./twitch.js")).ingestChatMessage(message);
    expect(await jobs()).toEqual([]);
    expect(network.mock.calls.map(([url]) => url.href)).toEqual([short, ...hops]);

    await (await import("../prisma.js")).prisma.$disconnect();
    vi.resetModules();
    restarted = true;
    await (await import("./twitch.js")).ingestChatMessage(message);
    expect(await jobs()).toEqual(address === "public" ? [{ url: first }] : []);
    expect(network.mock.calls.map(([url]) => url.href)).toEqual(address === "private" ? [short] : route);
  });
});
