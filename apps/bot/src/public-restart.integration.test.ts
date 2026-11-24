import { fork, type ChildProcess } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { once } from "node:events";
import { connect, createServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";
import { expect, it, vi } from "vitest";

const databaseUrl = process.env.PUBLIC_BOT_TEST_DATABASE_URL;

function processFixture(botId: number, duplicate = false) {
  const messages: { type: string; offset?: number; id?: number; text?: string }[] = [];
  let child: ChildProcess | undefined;
  let logs = "";
  function boot(updates: unknown[], recovering = false, datasource = databaseUrl) {
    child = fork(fileURLToPath(new URL("../test/public-bot-process.mjs", import.meta.url)), {
      silent: true, execArgv: ["--import", "tsx"], env: {
        ...process.env, DATABASE_URL: datasource, TELEGRAM_BOT_TOKEN: "1:fixture", TELEGRAM_PUBLIC_BOT_TOKEN: `${botId}:fixture`,
        TELEGRAM_STORAGE_CHAT_ID: "-100", TELEGRAM_ALLOWED_USER_IDS: "99", TELEGRAM_CONVERTER_BOT_TOKEN: "2:converter-fixture",
        TELEGRAM_CONVERTER_ALLOWED_USERNAMES: "viewer_fixture",
        FIXTURE_DUPLICATE: String(duplicate), FIXTURE_UPDATES: JSON.stringify(updates), FIXTURE_RECOVERING: String(recovering),
      },
    });
    child.stdout!.on("data", chunk => { logs += chunk; });
    child.stderr!.on("data", chunk => { logs += chunk; });
    child.on("message", event => messages.push(event as typeof messages[number]));
  }
  async function stop(signal: NodeJS.Signals) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "close");
    child.kill(signal);
    const [code, actualSignal] = await exited;
    if (signal === "SIGTERM") expect(code).toBe(0);
    else expect(actualSignal).toBe("SIGKILL");
  }
  return { boot, stop, messages, get logs() { return logs; } };
}

it.skipIf(!databaseUrl).each(["50 media and seven queued commands", "duplicate accepted during copy"] as const)("recovers after SIGKILL with %s", async scenario => {
  const duplicate = scenario === "duplicate accepted during copy";
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  const botId = randomInt(100_000, 1_000_000_000);
  const prefix = randomUUID();
  const chat = { id: 12, type: "private", first_name: "Viewer" };
  const viewer = { id: 12, is_bot: false, first_name: "Viewer" };
  const msg = { chat, from: viewer, message_id: 1, date: 1 };
  const fixture = processFixture(botId, duplicate);
  const { boot, stop, messages } = fixture;
  try {
    const streamer = await db.streamer.create({ data: { login: prefix, twitchUserId: prefix, displayName: "Fixture" } });
    const session = await db.streamSession.create({ data: { streamerId: streamer.id, startedAt: new Date() } });
    const urls = Array.from({ length: duplicate ? 1 : 50 }, (_, i) => `https://example.com/${prefix}/${i}.jpg`);
    await db.asset.createMany({ data: urls.map((url, i) => ({
      id: url, normalizedUrl: url, originalUrl: url, status: "stored", telegramChatId: "-100", telegramMessageId: i + 1,
    })) });
    await db.chatPost.createMany({ data: urls.map(url => ({
      assetId: url, streamSessionId: session.id, originalUrl: url, normalizedUrl: url, postedAt: new Date(),
      authorName: "Viewer", messageText: url, status: "stored",
    })) });
    const ids = [2, 3, 4, 5, 6, 7, 8];
    const page = { update_id: 1, callback_query: { id: "page", chat_instance: "archive", from: viewer, message: msg,
      data: `pub:stream:${session.id}:0` } };
    const commands = ids.map(id => ({ update_id: id, message: { ...msg,
      message_id: id, text: "/start", entities: [{ type: "bot_command", offset: 0, length: 6 }],
    } }));
    if (duplicate) {
      boot([page, { ...page, update_id: 2, callback_query: { ...page.callback_query, id: "duplicate" } }]);
      await vi.waitFor(() => {
        expect(messages.some(e => e.type === "duplicate-finish-before-commit")).toBe(true);
        expect(messages.some(e => e.type === "poll" && e.offset === 3)).toBe(true);
      }, { timeout: 8_000 });
      await stop("SIGKILL");
      expect(messages.filter(e => e.type === "copy")).toHaveLength(1);
      messages.length = 0;
      // Telegram has already confirmed both old updates. A new click must reopen the page.
      boot([{ ...page, update_id: 3, callback_query: { ...page.callback_query, id: "reopen" } }, commands[2]], true);
      await vi.waitFor(() => expect(messages.some(e => e.id === 4 && e.text === "Выбери стримера:")).toBe(true),
        { timeout: 12_000 });
      await stop("SIGTERM");
      expect(messages.filter(e => e.type === "ack").map(e => e.id).sort()).toEqual([2, 3]);
      expect(messages.filter(e => e.type === "reply" && e.text === "Показано: 1").map(e => e.id)).toEqual([3]);
      expect(messages.filter(e => e.type === "copy")).toHaveLength(1);
      expect(await db.publicBotUpdate.count({ where: { botId, payload: { not: Prisma.DbNull } } })).toBe(0);
      return;
    }
    boot([page, ...commands]);
    await vi.waitFor(() => {
      expect(messages.some(event => event.type === "poll" && event.offset === 9)).toBe(true);
      expect(messages.filter(event => event.type === "copy").length).toBeGreaterThanOrEqual(25);
    }, { timeout: 45_000 });
    await stop("SIGKILL");
    expect(messages.filter(event => event.type === "inbox-unavailable")).toHaveLength(1);
    expect(messages.filter(event => event.type === "inbox-commit-response-lost")).toHaveLength(1);
    expect(messages.filter(event => event.type === "copy")).toHaveLength(25);
    expect(messages.filter(event => event.text === "Выбери стримера:")).toEqual([]);
    messages.length = 0;
    boot([], true); // Telegram already acknowledged all eight updates.
    await vi.waitFor(() => expect(messages.filter(event => event.text === "Выбери стримера:").map(event => event.id)).toEqual(ids),
      { timeout: 23_000 });
    await stop("SIGTERM");
    expect(messages.filter(event => event.type === "copy")).toEqual([]);
    expect(messages.filter(event => event.type === "setup-outage")).toHaveLength(6);
    for (const type of ["admin-setup-503", "db-outage", "receipt-before-commit", "receipt-after-commit", "telegram-rate-limit", "shutdown-outage", "converter-shutdown-outage"]) {
      expect(messages.filter(event => event.type === type)).toHaveLength(1);
    }
    expect(fixture.logs).toContain("scope=setMyCommands");
    expect(fixture.logs).toContain("scope=shutdown");
    expect(fixture.logs).not.toContain(`${botId}:fixture`);
    expect(fixture.logs).not.toContain("1:fixture");
    expect(fixture.logs).not.toContain("2:converter-fixture");
    expect(await db.publicBotUpdate.count({ where: { botId, payload: { not: Prisma.DbNull } } })).toBe(0);
    expect(await db.publicBotUpdate.count({ where: { botId } })).toBe(8);
  } finally {
    await stop("SIGKILL");
    await db.publicBotUpdate.deleteMany({ where: { botId } });
    await db.streamer.deleteMany({ where: { login: prefix } });
    await db.asset.deleteMany({ where: { id: { contains: prefix } } });
    await db.$disconnect();
  }
}, 80_000);


it.skipIf(!databaseUrl)("keeps the same bot process polling once PostgreSQL comes online after lazy initialization", async () => {
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  const botId = randomInt(100_000, 1_000_000_000);
  const fixture = processFixture(botId);
  const target = new URL(databaseUrl!);
  const proxy = createServer(client => {
    const server = connect(Number(target.port || 5432), target.hostname);
    client.on("error", () => server.destroy());
    server.on("error", () => client.destroy());
    client.pipe(server).pipe(client);
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const { port } = proxy.address() as AddressInfo;
  await new Promise<void>(resolve => proxy.close(() => resolve()));
  const offline = new URL(target);
  offline.hostname = "127.0.0.1";
  offline.port = String(port);
  const command = { update_id: 1, message: {
    message_id: 1, date: 1, chat: { id: 1, type: "private", first_name: "Viewer" }, text: "/start",
    entities: [{ type: "bot_command", offset: 0, length: 6 }],
  } };
  try {
    fixture.boot([command], false, offline.toString());
    await vi.waitFor(() => expect(fixture.logs.match(/scope=public-inbox/g)?.length).toBeGreaterThanOrEqual(2), { timeout: 6000 });
    expect(fixture.messages.some(event => event.type === "poll")).toBe(false);
    proxy.listen(port, "127.0.0.1");
    await once(proxy, "listening");
    await vi.waitFor(() => expect(fixture.messages.some(event => event.type === "reply" && event.id === 1)).toBe(true), { timeout: 6000 });
    await fixture.stop("SIGTERM");
  } finally {
    await fixture.stop("SIGKILL");
    if (proxy.listening) await new Promise<void>(resolve => proxy.close(() => resolve()));
    await db.publicBotUpdate.deleteMany({ where: { botId } });
    await db.$disconnect();
  }
}, 18_000);
