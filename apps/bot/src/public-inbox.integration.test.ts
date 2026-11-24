import { randomInt } from "node:crypto";
import { Prisma } from "@prisma/client";
import { expect, it, vi } from "vitest";

const databaseUrl = process.env.PUBLIC_BOT_TEST_DATABASE_URL;

it.skipIf(!databaseUrl).each(["before", "after", "shutdown"])("keeps receipt claims safe on a write failure (%s)", async moment => {
  vi.resetModules();
  vi.stubEnv("DATABASE_URL", databaseUrl!);
  const { publicInbox } = await import("./public-inbox.js");
  const { prisma } = await import("./prisma.js");
  const botId = randomInt(100_000, 1_000_000_000);
  const inbox = publicInbox(botId);
  const table: { updateMany: (args: Prisma.PublicBotUpdateUpdateManyArgs) => Promise<{ count: number }> } = prisma.publicBotUpdate;
  const finish = table.updateMany.bind(table);
  const stop = new AbortController();
  const write = vi.spyOn(table, "updateMany").mockImplementation(finish).mockImplementationOnce(async args => {
    if (moment === "after") await finish(args);
    if (moment === "shutdown") stop.abort();
    throw new Prisma.PrismaClientKnownRequestError("connection closed", { code: "P1017", clientVersion: "test" });
  });
  try {
    const page = { update_id: 1, callback_query: { id: "first", from: { id: 1, first_name: "Test", is_bot: false },
      chat_instance: "archive", data: "pub:stream:recovery:0" } };
    await inbox.accept([page]);
    const claim = inbox.claimPage(1, stop.signal);
    if (moment === "shutdown") {
      await expect(claim).rejects.toThrow("Could not commit");
      expect(write).toHaveBeenCalledOnce();
      expect(await inbox.recover()).toEqual([page]);
    } else {
      expect(await claim).toBe(moment === "before");
      expect(write).toHaveBeenCalledTimes(2);
      expect(await inbox.recover()).toEqual([]);
    }
  } finally {
    write.mockRestore();
    await prisma.publicBotUpdate.deleteMany({ where: { botId } });
    await prisma.$disconnect();
    vi.unstubAllEnvs();
  }
});

it.skipIf(!databaseUrl)("keeps the original pending payload and skips finished receipts on redelivery", async () => {
  vi.resetModules();
  vi.stubEnv("DATABASE_URL", databaseUrl!);
  const { publicInbox } = await import("./public-inbox.js");
  const { prisma } = await import("./prisma.js");
  const botId = randomInt(100_000, 1_000_000_000);
  const inbox = publicInbox(botId);
  const original = { update_id: 5 };
  const finished = { update_id: 6 };
  try {
    await inbox.accept([original, finished]);
    await inbox.finish(finished.update_id, new AbortController().signal);
    const fresh = { update_id: 7 };
    const changed = { update_id: 5, poll_answer: { poll_id: "changed", option_ids: [], user: { id: 1, first_name: "Viewer", is_bot: false } } };
    expect(await inbox.accept([changed, finished, fresh, fresh])).toEqual([original, fresh]);
    expect(await inbox.recover()).toEqual([original, fresh]);
  } finally {
    await prisma.publicBotUpdate.deleteMany({ where: { botId } });
    await prisma.$disconnect();
    vi.unstubAllEnvs();
  }
});

it.skipIf(!databaseUrl)("classifies queued and legacy page clicks durably and allows reopening after completion", async () => {
  vi.resetModules();
  vi.stubEnv("DATABASE_URL", databaseUrl!);
  const { publicInbox } = await import("./public-inbox.js");
  const { ackOnly, publicPageKey } = await import("./public-page.js");
  const { prisma } = await import("./prisma.js");
  const botId = randomInt(100_000, 1_000_000_000);
  const inbox = publicInbox(botId);
  const signal = new AbortController().signal;
  function click(id: number, session = "same") {
    return { update_id: id, callback_query: { id: String(id), chat_instance: "archive", from: { id: 1, first_name: "Test", is_bot: false },
      data: `pub:stream:${session}:0` } };
  }
  try {
    // Row 1 was backfilled by migration. Rows 2–4 were written by a pre-upgrade bot.
    await prisma.publicBotUpdate.createMany({ data: [click(1), click(2), click(3, "legacy"), click(4, "legacy")].map(update => ({
      botId, updateId: update.update_id, payload: update, pageKey: update.update_id === 1 ? publicPageKey(update) : null,
    })) });
    expect((await inbox.recover()).map(update => [update.update_id, ackOnly in update])).toEqual([
      [1, false], [2, true], [3, false], [4, true],
    ]);
    const accepted = await inbox.accept([click(5), click(6, "legacy"), click(7, "new"), click(8, "new")]);
    expect(accepted.map(update => ackOnly in update)).toEqual([true, true, false, true]);
    await inbox.claimPage(1, signal);
    await inbox.finish(1, signal);
    const reopen = click(9);
    expect(await inbox.accept([reopen])).toEqual([reopen]);
    expect((await inbox.recover()).filter(update => !(ackOnly in update)).map(update => update.update_id)).toEqual([3, 7, 9]);
    expect((await inbox.accept([click(2), click(5)])).every(update => ackOnly in update)).toBe(true);
  } finally {
    await prisma.publicBotUpdate.deleteMany({ where: { botId } });
    await prisma.$disconnect();
    vi.unstubAllEnvs();
  }
});
