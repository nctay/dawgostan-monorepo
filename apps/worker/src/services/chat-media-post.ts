import { randomUUID } from "node:crypto";
import { Prisma, type Asset } from "@prisma/client";
import { prisma } from "../prisma.js";

import { lockWtvMessage } from "./wtv-short-links.js";

type ChatMediaPost = Pick<Prisma.ChatPostUncheckedCreateInput,
  "streamSessionId" | "twitchMessageId" | "rawTwitchMessageId" | "authorTwitchId" | "authorName" |
  "messageText" | "originalUrl" | "normalizedUrl" | "postedAt" | "skipTelegramPublic"
> & { deferPublicCopy?: boolean };

type SavedPost =
  | { outcome: "duplicate" | "blocked" }
  | { outcome: "stored"; postId: string; asset: Asset }
  | { outcome: "queued" | "active"; postId: string; assetId: string };

export async function saveChatMediaPost({ deferPublicCopy, ...input }: ChatMediaPost): Promise<SavedPost> {
  const { normalizedUrl, originalUrl } = input;
  function publicRetryAt(asset: Asset) {
    return deferPublicCopy && !input.skipTelegramPublic && asset.visibility === "public" &&
      asset.telegramChatId && asset.telegramMessageId ? new Date() : null;
  }
  try {
    return await prisma.$transaction(async (tx): Promise<SavedPost> => {
      const messageId = input.rawTwitchMessageId;
      if (messageId?.startsWith("wtv:")) {
        await lockWtvMessage(tx, messageId);
        // A page edit can arrive while an earlier worker is resolving this URL.
        if (!input.skipTelegramPublic) {
          const [row] = await tx.$queryRaw<[{ suppressed: boolean }]>`
            SELECT EXISTS (SELECT FROM wtv_message_owners WHERE "sessionId" = ${input.streamSessionId}
              AND "messageId" = ${messageId} AND "skipTelegramPublic")
            OR EXISTS (SELECT FROM wtv_pending_messages WHERE "sessionId" = ${input.streamSessionId}
              AND "messageId" = ${messageId} AND "skipTelegramPublic")
            OR EXISTS (SELECT FROM chat_posts WHERE "streamSessionId" = ${input.streamSessionId}
              AND "rawTwitchMessageId" = ${messageId} AND "skipTelegramPublic") AS suppressed
          `;
          input.skipTelegramPublic = row.suppressed;
        }
      }
      const [match] = await tx.$queryRaw<[{ blocked: boolean; storedId: string | null }]>`
        SELECT EXISTS (SELECT FROM blocked_media WHERE "normalizedUrl" = ${normalizedUrl}) AS blocked,
               COALESCE(
                 (SELECT id FROM assets WHERE "normalizedUrl" = ${normalizedUrl} AND status = 'stored'),
                 (SELECT p."assetId" FROM chat_posts p JOIN assets a ON a.id = p."assetId"
                  WHERE p."normalizedUrl" = ${normalizedUrl} AND p.status = 'stored' AND a.status = 'stored'
                  ORDER BY p."postedAt" LIMIT 1)
               ) AS "storedId"
      `;
      if (match.blocked) {
        await tx.chatPost.create({ data: { ...input, status: "blocked" }, select: { id: true } });
        return { outcome: "blocked" };
      }
      const storedAsset = match.storedId ? await tx.asset.findUnique({ where: { id: match.storedId, status: "stored" } }) : null;
      if (storedAsset) {
        const post = await tx.chatPost.create({
          data: { ...input, assetId: storedAsset.id, status: "stored", publicRetryAt: publicRetryAt(storedAsset) },
          select: { id: true },
        });
        return { outcome: "stored", asset: storedAsset, postId: post.id };
      }

      // A native upsert locks this URL's asset until commit. A competing writer
      // checks the active jobs in a later statement, after it acquires the lock.
      const newId = randomUUID();
      let asset = await tx.asset.upsert({
        where: { normalizedUrl }, create: { id: newId, originalUrl, normalizedUrl }, update: { normalizedUrl },
      });
      // A downloader can finish a SHA match while this writer waits on the URL's
      // asset. The canonical file then lives on a different asset.
      if (asset.id !== newId && asset.status !== "stored") {
        const storedPost = await tx.chatPost.findFirst({
          where: { normalizedUrl, status: "stored", asset: { status: "stored" } },
          orderBy: { postedAt: "asc" }, select: { asset: true },
        });
        if (storedPost?.asset) asset = storedPost.asset;
      }
      const stored = asset.status === "stored";
      if (asset.status === "failed") {
        await tx.asset.update({ where: { id: asset.id }, data: { status: "pending" }, select: { id: true } });
      }
      const post = await tx.chatPost.create({
        data: { ...input, assetId: asset.id, status: stored ? "stored" : "pending", publicRetryAt: stored ? publicRetryAt(asset) : null },
        select: { id: true },
      });
      if (stored) return { outcome: "stored", asset, postId: post.id };

      const queued = await tx.$executeRaw`
        INSERT INTO download_jobs (id, "assetId", "chatPostId", url, "createdAt", "updatedAt")
        SELECT gen_random_uuid()::text, ${asset.id}, ${post.id}, ${originalUrl},
               CURRENT_TIMESTAMP AT TIME ZONE 'UTC', CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
        WHERE NOT EXISTS (
          SELECT FROM download_jobs WHERE "assetId" = ${asset.id} AND status IN ('pending', 'running')
        )
      `;
      return { outcome: queued ? "queued" : "active", postId: post.id, assetId: asset.id };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" &&
        Array.isArray(error.meta?.target) && error.meta.target.includes("twitchMessageId")) {
      return { outcome: "duplicate" };
    }
    throw error;
  }
}
