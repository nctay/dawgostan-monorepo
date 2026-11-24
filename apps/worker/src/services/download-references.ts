import { Prisma } from "@prisma/client";
import { env, privateStreamerLogins } from "../env.js";
import { prisma } from "../prisma.js";

// Ingestion locks the URL's asset before attaching a post. Take the same lock
// before each terminal transition so it sees every post joining that job.
function lockDownloadAssets(normalizedUrl: string, ids: string[]) {
  return prisma.$queryRaw`SELECT id FROM assets WHERE "normalizedUrl" = ${normalizedUrl}
    ${ids.length ? Prisma.sql`OR id IN (${Prisma.join(ids)})` : Prisma.empty} ORDER BY id FOR UPDATE`;
}

export async function markStoredReferences(assetId: string, normalizedUrl: string, jobId: string, chatPostId: string, staleAssetId?: string | null, recoverPublicDelivery = false): Promise<void> {
  const duplicateAssetIds = [assetId, staleAssetId].filter((id): id is string => Boolean(id));

  await prisma.$transaction([
    lockDownloadAssets(normalizedUrl, duplicateAssetIds),
    // Each newly stored w.tv post carries its own delivery intent, including
    // eligible viewers who joined a download whose original sender opted out.
    prisma.$executeRaw`UPDATE chat_posts p
      SET "assetId" = a.id, status = 'stored',
          "publicRetryAt" = CASE WHEN ${Boolean(env.TELEGRAM_PUBLIC_CHANNEL_ID)}
            AND (${recoverPublicDelivery} OR COALESCE(p."rawTwitchMessageId", p."twitchMessageId") LIKE 'wtv:%')
            AND NOT p."skipTelegramPublic" AND a.visibility = 'public'
            AND a."telegramChatId" IS NOT NULL AND a."telegramMessageId" IS NOT NULL
            AND lower(s.login) <> ALL(${[...privateStreamerLogins]}::text[])
            THEN CURRENT_TIMESTAMP AT TIME ZONE 'UTC' END
      FROM assets a, stream_sessions session JOIN streamers s ON s.id = session."streamerId"
      WHERE a.id = ${assetId} AND session.id = p."streamSessionId" AND p.status IN ('pending', 'failed')
        AND (p.id = ${chatPostId} OR p."assetId" IN (${Prisma.join(duplicateAssetIds)}) OR p."normalizedUrl" = ${normalizedUrl})`,
    prisma.downloadJob.updateMany({
      where: {
        id: { not: jobId },
        assetId: { in: duplicateAssetIds },
        status: { in: ["pending", "failed"] },
      },
      data: {
        assetId,
        status: "done",
        nextRetryAt: null,
        lastError: null,
      },
    }),
    prisma.downloadJob.update({
      where: { id: jobId },
      data: {
        assetId,
        status: "done",
        nextRetryAt: null,
        lastError: null,
      },
    }),
  ]);
}

export async function failDownload(jobId: string, chatPostId: string, normalizedUrl: string, assetId: string | null, message: string) {
  await prisma.$transaction([
    lockDownloadAssets(normalizedUrl, assetId ? [assetId] : []),
    prisma.downloadJob.update({ where: { id: jobId }, data: { status: "failed", lastError: message, nextRetryAt: null } }),
    prisma.chatPost.updateMany({
      where: { status: "pending", OR: [{ id: chatPostId }, { normalizedUrl }] }, data: { status: "failed" },
    }),
    prisma.asset.updateMany({ where: { id: assetId ?? "", status: "pending" }, data: { status: "failed" } }),
  ]);
}

export async function markBlocked(jobId: string, chatPostId: string, normalizedUrl: string, reason: string): Promise<void> {
  await prisma.$transaction([
    lockDownloadAssets(normalizedUrl, []),
    prisma.chatPost.updateMany({
      where: { status: "pending", OR: [{ id: chatPostId }, { normalizedUrl }] }, data: { status: "blocked" },
    }),
    prisma.downloadJob.update({ where: { id: jobId }, data: { status: "blocked", lastError: reason } }),
  ]);
}
