import { execFile, fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { Api } from "grammy";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const databaseUrl = process.env.TWITCH_CHAT_TEST_DATABASE_URL;
vi.mock("@dawgostan/media-processing", async importOriginal => ({
  ...await importOriginal<typeof import("@dawgostan/media-processing")>(),
  normalizePhotoForTelegram: async (filePath: string, mimeType: string) => ({ filePath, mimeType }),
}));

describe.skipIf(!databaseUrl)("public copies of w.tv downloads on PostgreSQL", () => {
  const schema = `download_public_${randomUUID().replaceAll("-", "")}`;
  const fixture = new URL(databaseUrl ?? "postgresql://localhost/test");
  fixture.searchParams.set("schema", schema);
  let sessionId: string;
  const login = "streamer";
  const storage = "-100";
  const channel = "-200";
  const direct = (name: string) => `https://media.example/${name}.jpg`;
  const photo = (id: number) => ({
    message_id: id, date: 0, chat: { type: "channel" as const, id: Number(storage), title: "storage" },
    photo: [{ file_id: `file-${id}`, file_unique_id: `unique-${id}`, width: 1, height: 1 }],
  });
  async function ingest(id: string, messageText: string) {
    const { ingestChatMessage } = await import("./twitch.js");
    await ingestChatMessage({ twitchMessageId: `wtv:${id}`, streamerLogin: login, authorName: id, postedAt: new Date(), messageText });
  }
  async function download() {
    const { processDownloadQueue, waitForDownloadQueue } = await import("./downloader.js");
    processDownloadQueue();
    await waitForDownloadQueue();
  }
  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", fixture.href);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "1:fixture");
    vi.stubEnv("TELEGRAM_PUBLIC_CHANNEL_ID", channel);
    vi.stubEnv("TELEGRAM_STORAGE_CHAT_ID", storage);
    vi.stubEnv("TELEGRAM_PRIVATE_STREAMER_LOGINS", "private_streamer");
    vi.stubEnv("ALLOW_PRIVATE_MEDIA_HOSTS", "true");
    vi.stubEnv("MAX_PARALLEL_DOWNLOADS", "1");
    await promisify(execFile)("pnpm", ["-w", "db:migrate"]);
    const { prisma } = await import("../prisma.js");
    const session = await prisma.streamSession.create({ data: {
      streamer: { create: { login, displayName: login, twitchUserId: `wtv:${login}` } }, startedAt: new Date(Date.now() - 60_000),
    } });
    sessionId = session.id;
  }, 30_000);
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    const { prisma } = await import("../prisma.js");
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await prisma.$disconnect();
    vi.unstubAllEnvs();
  });

  it("applies an edit received during the storage upload and delivers an independent public post once", async () => {
    const { prisma } = await import("../prisma.js");
    const { processPublicReposts } = await import("./public-reposts.js");
    const url = direct("private");
    const control = direct("control");
    vi.stubGlobal("fetch", async (input: URL) => new Response(input.href, { headers: { "content-type": "image/jpeg" } }));
    const upload = vi.spyOn(Api.prototype, "sendPhoto")
      .mockImplementationOnce(async () => {
        await ingest("edited", `!skip_tg ${url}`);
        return photo(1);
      })
      .mockResolvedValueOnce(photo(2));
    const copy = vi.spyOn(Api.prototype, "copyMessage").mockResolvedValue({ message_id: 101 });
    await ingest("edited", url);
    await ingest("control", control);
    await download();
    expect(upload.mock.calls.map(([chat]) => chat)).toEqual([storage, storage]);
    const post = await prisma.chatPost.findFirstOrThrow({ where: { normalizedUrl: url } });
    expect(post).toMatchObject({ status: "stored", skipTelegramPublic: true, publicRetryAt: null });
    expect(await prisma.chatPost.findFirstOrThrow({ where: { normalizedUrl: control } }))
      .toMatchObject({ status: "stored", publicRetryAt: expect.any(Date) });
    expect(copy).not.toHaveBeenCalled();
    await processPublicReposts();
    await processPublicReposts();
    expect(copy.mock.calls.map(([chat, from, id]) => [chat, from, id])).toEqual([[channel, storage, 2]]);
  }, 15_000);

  it("queues a public viewer who joins an album upload while the original viewer marks it private", async () => {
    const { prisma } = await import("../prisma.js");
    const { processPublicReposts } = await import("./public-reposts.js");
    const url = "https://imgur.com/a/sAUWwPJ";
    vi.stubGlobal("fetch", async (input: URL | string) => String(input).includes("ajaxalbums") ?
      Response.json({ success: true, data: { count: 2, images: [{ hash: "first", ext: ".jpg" }, { hash: "second", ext: ".jpg" }] } }) :
      new Response(String(input), { headers: { "content-type": "image/jpeg" } }));
    const albums = vi.spyOn(Api.prototype, "sendMediaGroup")
      .mockImplementationOnce(async () => {
        await ingest("owner", `!skip_tg ${url}`);
        await ingest("joined", `public caption ${url}`);
        return [photo(3), photo(4)];
      })
      .mockResolvedValue([photo(103), photo(104)]);
    await ingest("owner", `private caption ${url}`);
    await download();
    expect(await prisma.downloadJob.count({ where: { url, status: "done" } })).toBe(1);
    expect(await prisma.chatPost.count({ where: { normalizedUrl: url, status: "stored" } })).toBe(2);
    expect(albums.mock.calls.map(([chat]) => chat)).toEqual([storage]);
    await processPublicReposts();
    await processPublicReposts();
    expect(albums.mock.calls.map(([chat]) => chat)).toEqual([storage, channel]);
    expect(albums.mock.calls[1]![1]).toEqual([
      { type: "photo", media: "file-3", caption: expect.stringContaining("#user_joined: public caption") },
      { type: "photo", media: "file-4" },
    ]);
  }, 15_000);

  it.each(["sha", "url", "url alias"])("checks the edited post when the worker reuses stored media by %s", async mode => {
    const { prisma } = await import("../prisma.js");
    const { processPublicReposts } = await import("./public-reposts.js");
    const id = mode.replace(" ", "-");
    const url = direct(`reused-${id}`);
    await ingest(id, url);
    const where = { normalizedUrl: url };
    const receipt = { status: "stored" as const, telegramChatId: storage, telegramMessageId: 7 };
    let canonical;
    if (mode === "url") {
      canonical = await prisma.asset.update({ where, data: receipt });
    } else {
      const canonicalUrl = direct(`canonical-${id}`);
      canonical = await prisma.asset.create({ data: { ...receipt, normalizedUrl: canonicalUrl, originalUrl: canonicalUrl,
        sha256: createHash("sha256").update(url).digest("hex") } });
      if (mode === "url alias") await prisma.chatPost.create({ data: {
        streamSessionId: sessionId, authorName: "earlier", messageText: url, originalUrl: url,
        normalizedUrl: url, postedAt: new Date(), status: "stored", assetId: canonical.id,
      } });
    }
    // The worker can read the stored asset and claim the job, but cannot finish
    // the transition until the edit has committed.
    const copy = vi.spyOn(Api.prototype, "copyMessage").mockResolvedValue({ message_id: 107 });
    vi.stubGlobal("fetch", async () => new Response(url, { headers: { "content-type": "image/jpeg" } }));
    let running: Promise<void> | undefined;
    try {
      await prisma.$transaction(async tx => {
        const [lock] = await tx.$queryRaw<[{ pid: number }]>`SELECT pg_backend_pid() AS pid FROM assets WHERE id = ${canonical.id} FOR UPDATE`;
        running = download();
        await vi.waitUntil(async () => {
          const [row] = await prisma.$queryRaw<[{ waiting: boolean }]>`SELECT EXISTS (
            SELECT FROM pg_stat_activity WHERE ${lock.pid}::int = ANY(pg_blocking_pids(pid))) AS waiting`;
          return row.waiting;
        }, { timeout: 3000 });
        await ingest(id, `!skip_tg ${url}`);
      });
    } finally {
      await running;
    }
    await processPublicReposts();
    expect(await prisma.chatPost.findFirstOrThrow({ where: { rawTwitchMessageId: `wtv:${id}` } }))
      .toMatchObject({ assetId: canonical.id, status: "stored", skipTelegramPublic: true, publicRetryAt: null });
    expect(copy).not.toHaveBeenCalled();
  }, 15_000);

  it.each([false, true])("finishes a confirmed upload after SIGKILL before the post transition (private %s)", async privatePost => {
    const { prisma } = await import("../prisma.js");
    const { recoverInterruptedDownloadJobs } = await import("./downloader.js");
    const { processPublicReposts } = await import("./public-reposts.js");
    const url = direct(`restart-${privatePost}`);
    await ingest(`restart-${privatePost}`, `${privatePost ? "!skip_tg " : ""}${url}`);
    const post = await prisma.chatPost.findFirstOrThrow({ where: { normalizedUrl: url } });
    const scratch = await mkdtemp(path.join(tmpdir(), "storage-restart-"));
    let child: ChildProcess | undefined;
    let logs = "";
    const upload = vi.spyOn(Api.prototype, "sendPhoto").mockRejectedValue(new Error("Unexpected storage reupload"));
    const copy = vi.spyOn(Api.prototype, "copyMessage").mockResolvedValue({ message_id: 436 });
    try {
      await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM chat_posts WHERE id = ${post.id} FOR UPDATE`;
        child = fork(fileURLToPath(new URL("../../test/storage-restart-process.mjs", import.meta.url)), {
          silent: true, execArgv: ["--import", "tsx"], env: { ...process.env, DATABASE_URL: fixture.href, TMPDIR: scratch },
        });
        child.stdout!.on("data", chunk => { logs += chunk; });
        child.stderr!.on("data", chunk => { logs += chunk; });
        await vi.waitUntil(async () => (await prisma.asset.findUnique({ where: { normalizedUrl: url } }))?.telegramMessageId === 435,
          { timeout: 10_000 });
        const exited = once(child, "close");
        child.kill("SIGKILL");
        expect(await exited, logs).toEqual([null, "SIGKILL"]);
        child = undefined;
      }, { timeout: 15_000 });
      await recoverInterruptedDownloadJobs();
      await recoverInterruptedDownloadJobs();
      await download();
      await processPublicReposts();
      await processPublicReposts();
      expect(await prisma.chatPost.findUnique({ where: { id: post.id }, include: { downloadJobs: true, asset: true } }))
        .toMatchObject({ status: "stored", publicRetryAt: null, downloadJobs: [{ status: "done" }],
          asset: { telegramMessageId: 435, publicTelegramMessageId: privatePost ? null : 436 } });
      expect(copy.mock.calls.map(args => args.slice(0, 3))).toEqual(privatePost ? [] : [[channel, storage, 435]]);
      expect(upload).not.toHaveBeenCalled();
    } finally {
      if (child) { const exited = once(child, "close"); child.kill("SIGKILL"); await exited; }
      await rm(scratch, { recursive: true, force: true });
      await prisma.chatPost.delete({ where: { id: post.id } });
      await prisma.asset.deleteMany({ where: { normalizedUrl: url } });
    }
  }, 20_000);
});
