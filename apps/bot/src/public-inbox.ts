import { Prisma } from "@prisma/client";
import type { Update } from "grammy/types";
import { retryInbox } from "./database-errors.js";
import { prisma } from "./prisma.js";
import { ackOnly, publicPageKey } from "./public-page.js";

export class PublicInboxError extends Error {}

export function publicInbox(botId: number) {
  const table = prisma.publicBotUpdate;
  async function writeReceipt(where: Prisma.PublicBotUpdateWhereInput, data: Prisma.PublicBotUpdateUpdateManyMutationInput, signal: AbortSignal) {
    try {
      const { count } = await retryInbox(() => table.updateMany({ where: { botId, ...where }, data }), signal);
      return count > 0;
    } catch (cause) {
      throw new PublicInboxError("Could not commit public bot update", { cause });
    }
  }
  return {
    async recover() {
      const rows = await table.findMany({
        where: { botId, OR: [{ payload: { not: Prisma.DbNull } }, { pageKey: { not: null } }] },
        orderBy: [{ receivedAt: "asc" }, { updateId: "asc" }], select: { updateId: true, payload: true, pageKey: true },
      });
      const owners = new Set(rows.map(row => row.pageKey));
      const pending: Update[] = [];
      const repairs = [];
      for (const row of rows) {
        if (row.payload === null) continue;
        const update = row.payload as unknown as Update;
        const key = publicPageKey(update);
        // An older bot may still insert ordinary unclassified receipts during deployment.
        if (key && !row.pageKey && !(ackOnly in update)) {
          const data = owners.has(key)
            ? { payload: Object.assign(update, { [ackOnly]: true }) as unknown as Prisma.InputJsonObject }
            : { pageKey: key };
          owners.add(key);
          repairs.push(table.update({ where: { botId_updateId: { botId, updateId: row.updateId } }, data, select: { updateId: true } }));
        }
        pending.push(update);
      }
      // Release previously claimed pages after classifying any older duplicates against them.
      await prisma.$transaction([...repairs, table.updateMany({
        where: { botId, payload: { equals: Prisma.DbNull }, pageKey: { not: null } }, data: { pageKey: null },
      })]);
      return pending;
    },
    async accept(updates: Update[]) {
      if (!updates.length) return [];
      const ids = [...new Set(updates.map(update => update.update_id))];
      const data = updates.map(update => ({
        botId, updateId: update.update_id, pageKey: publicPageKey(update), payload: update as unknown as Prisma.InputJsonObject,
      }));
      // The unique page key covers queued and sending pages. Insert any losing
      // clicks as ACK-only receipts in the same commit, before advancing Telegram's offset.
      const duplicates = data.filter(row => row.pageKey !== null).map(row => ({
        ...row, pageKey: null, payload: { ...row.payload, [ackOnly]: true },
      }));
      const [, , rows] = await prisma.$transaction([
        table.createMany({ data, skipDuplicates: true }),
        table.createMany({ data: duplicates, skipDuplicates: true }),
        table.findMany({ where: { botId, updateId: { in: ids }, payload: { not: Prisma.DbNull } },
          select: { updateId: true, payload: true } }),
      ]);
      const pending = new Map(rows.map(row => [row.updateId, row.payload as unknown as Update]));
      return ids.flatMap(id => pending.get(id) ?? []);
    },
    claimPage(updateId: number, signal: AbortSignal) {
      // Only a confirmed transition can start delivery. Keep ownership through the footer.
      return writeReceipt({ updateId, pageKey: { not: null }, payload: { not: Prisma.DbNull } }, { payload: Prisma.DbNull }, signal);
    },
    finish(updateId: number, signal: AbortSignal) {
      return writeReceipt({ updateId }, { payload: Prisma.DbNull, pageKey: null }, signal);
    },
    async prune() {
      // Telegram keeps unconfirmed updates for 24h. Keep receipt IDs beyond that window.
      await table.deleteMany({ where: { botId, pageKey: null, payload: { equals: Prisma.DbNull }, receivedAt: { lt: new Date(Date.now() - 2 * 86_400_000) } } });
    },
  };
}
