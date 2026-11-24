import { logServiceAlert, classifyOperationalError } from "../alert-log.js";
import { env, privateStreamerLogins } from "../env.js";
import { prisma } from "../prisma.js";
import { publicChannelCaption, publicChannelSendLimiter, publicRepeatWindowMs, sendStoredTelegramMediaBatch, telegramMediaGroupMaxItems } from "./telegram-storage.js";

const leaseMs = 10 * 60 * 1000;

async function reserveBatch(id: string) {
  return prisma.$transaction(async tx => {
    const now = new Date();
    const lease = new Date(now.getTime() + leaseMs);
    const locked = await tx.chatPost.updateMany({ where: { id, publicRetryAt: { lte: now } }, data: { publicRetryAt: lease } });
    if (!locked.count) return;
    const post = await tx.chatPost.findUniqueOrThrow({
      where: { id },
      include: { asset: true, streamSession: { select: { startedAt: true, streamer: { select: { login: true } } } } },
    });
    const { asset, streamSession, publicFileOffset: offset } = post;
    const streamerLogin = streamSession.streamer.login;
    if (!asset?.telegramChatId || !asset.telegramMessageId || asset.visibility !== "public" || asset.status !== "stored" ||
        post.status !== "stored" || post.skipTelegramPublic || privateStreamerLogins.has(streamerLogin.toLowerCase())) {
      await tx.chatPost.update({ where: { id }, data: { publicRetryAt: null } });
      if (asset && post.publicClaimedAt && offset === 0) {
        await tx.asset.updateMany({
          where: { id: asset.id, publicTelegramPublishedAt: post.publicClaimedAt },
          data: { publicTelegramPublishedAt: null },
        });
      }
      return;
    }

    // Share the 48-hour claim with downloads and Twitch reposts of the same asset.
    const claimedAt = now;
    const cutoff = new Date(now.getTime() - publicRepeatWindowMs);
    const ownership = post.publicClaimedAt
      ? { publicTelegramPublishedAt: post.publicClaimedAt }
      : { OR: [{ publicTelegramPublishedAt: null }, { publicTelegramPublishedAt: { lte: cutoff } }] };
    const claim = await tx.asset.updateMany({
      where: { id: asset.id, visibility: "public", ...ownership },
      data: { publicTelegramPublishedAt: claimedAt },
    });
    if (!claim.count) {
      // Another path may still be awaiting Telegram. Keep this intent until
      // that path either confirms delivery or releases its reservation.
      await tx.chatPost.update({ where: { id }, data: { publicRetryAt: lease } });
      return;
    }

    // Telegram has no idempotency key. Reserve just the outgoing batch, so a
    // lost acknowledgement cannot replay it or suppress the rest of the album.
    const count = Math.max(asset.telegramFileIds.length, 1);
    const next = Math.min(offset + telegramMediaGroupMaxItems, count);
    const more = next < count;
    await tx.chatPost.update({
      where: { id },
      data: { publicClaimedAt: claimedAt, publicFileOffset: next, publicRetryAt: more ? lease : null },
    });
    const caption = publicChannelCaption({ ...post, streamerLogin, streamStartedAt: streamSession.startedAt });
    return { asset, caption, offset, more, where: { id, publicClaimedAt: claimedAt, publicFileOffset: next } };
  });
}

async function deliverNextBatch(chatId: string, postId: string, signal?: AbortSignal) {
  if (signal?.aborted) return;
  const batch = await reserveBatch(postId);
  if (!batch) return;
  const { where, offset, asset } = batch;
  async function releaseBatch(retryAt: Date | null) {
    // A definite refusal before the first send can give way to a different
    // eligible post of the same asset, e.g. if this post becomes private.
    await prisma.$transaction(async tx => {
      const restored = await tx.chatPost.updateMany({
        where, data: { publicFileOffset: offset, publicRetryAt: retryAt,
          ...(offset === 0 ? { publicClaimedAt: null } : {}) },
      });
      if (restored.count && offset === 0) {
        await tx.asset.updateMany({ where: { id: asset.id, publicTelegramPublishedAt: where.publicClaimedAt },
          data: { publicTelegramPublishedAt: null } });
      }
    });
  }
  if (signal?.aborted) {
    await releaseBatch(new Date());
    return;
  }

  let sent: { message_id: number };
  try {
    sent = await sendStoredTelegramMediaBatch(chatId, asset, batch.caption, offset);
  } catch (error) {
    const api = error as { error_code?: number; parameters?: { retry_after?: number } } | null;
    const code = classifyOperationalError(error).code;
    if (api?.error_code === 429 || (api?.error_code ?? 0) >= 500 || code === "dns" || code === "connection_refused") {
      await releaseBatch(new Date(Date.now() + Math.max(api?.parameters?.retry_after ?? 30, 1) * 1000));
    } else if (api?.error_code) {
      await releaseBatch(null);
    }
    logServiceAlert({ code: "public_repost_send_failed", component: "telegram", title: "Не удалось доставить публикацию", error,
      details: { chatPostId: postId, offset } });
    return;
  }

  // Close the repeat window at confirmed delivery. A multipart post carries
  // this timestamp forward as its ownership token for the next reservation.
  await prisma.$transaction(async tx => {
    const deliveredAt = new Date();
    const recorded = await tx.chatPost.updateMany({
      where, data: { publicClaimedAt: deliveredAt, publicRetryAt: batch.more ? deliveredAt : null },
    });
    if (recorded.count) {
      await tx.asset.updateMany({
        where: { id: asset.id, publicTelegramPublishedAt: where.publicClaimedAt },
        data: { publicTelegramPublishedAt: deliveredAt, publicTelegramConfirmedAt: deliveredAt,
          ...(offset === 0 ? { publicTelegramChatId: chatId, publicTelegramMessageId: sent.message_id } : {}) },
      });
    }
  });
}

export async function processPublicReposts(signal?: AbortSignal): Promise<void> {
  const chatId = env.TELEGRAM_PUBLIC_CHANNEL_ID;
  if (!chatId) return;
  while (!signal?.aborted) {
    const post = await prisma.chatPost.findFirst({
      where: { publicRetryAt: { lte: new Date() } },
      orderBy: [{ publicRetryAt: "asc" }, { id: "asc" }],
      select: { id: true, publicClaimedAt: true, asset: { select: { id: true, publicTelegramPublishedAt: true, publicTelegramConfirmedAt: true } } },
    });
    if (!post) return;
    const cutoff = new Date(Date.now() - publicRepeatWindowMs);
    if (!post.publicClaimedAt && post.asset?.publicTelegramConfirmedAt && post.asset.publicTelegramConfirmedAt > cutoff) {
      // Drain duplicates in one update without consuming a channel send slot.
      // Only confirmed deliveries can consume another post's intent.
      await prisma.chatPost.updateMany({
        where: { assetId: post.asset.id, publicClaimedAt: null, publicRetryAt: { lte: new Date() },
          asset: { publicTelegramConfirmedAt: { gt: cutoff } } },
        data: { publicRetryAt: null },
      });
      continue;
    }
    if (!post.publicClaimedAt && post.asset?.publicTelegramPublishedAt && post.asset.publicTelegramPublishedAt > cutoff) {
      // Do not wait behind the same asset's in-flight send in the shared limiter.
      await prisma.chatPost.updateMany({
        where: { id: post.id, publicClaimedAt: null, publicRetryAt: { lte: new Date() },
          asset: { publicTelegramPublishedAt: { gt: cutoff } } },
        data: { publicRetryAt: new Date(Date.now() + 30_000) },
      });
      continue;
    }
    await publicChannelSendLimiter.schedule(() => deliverNextBatch(chatId, post.id, signal));
  }
}
