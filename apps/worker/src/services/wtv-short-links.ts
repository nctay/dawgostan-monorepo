import { extractUrls, hasSkipTelegramPublicTag, normalizeUrl, stripSkipTelegramPublicTag } from "@dawgostan/core";
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { isShortLinkUrl, isSupportedMediaCandidateUrl, resolveShortLink, type RedirectProgress } from "./redirect-resolver.js";

type Message = { authorName: string; authorTwitchId?: string; messageText: string; postedAt: Date; skipTelegramPublic?: boolean };

export async function lockWtvMessage(tx: Prisma.TransactionClient, messageId: string) {
  await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${messageId}, 0))`;
}

// The caller holds the message locks. Do not rewrite an owner on retries or let a later broadcast take it.
export async function claimWtvMessages(tx: Prisma.TransactionClient, sessionId: string, ids: string[], privateIds: string[]) {
  await tx.$executeRaw`
    INSERT INTO wtv_message_owners AS owner ("messageId", "sessionId", "skipTelegramPublic")
    SELECT DISTINCT id, ${sessionId}, id = ANY(${privateIds}::text[]) FROM unnest(${ids}::text[]) AS entries(id)
    ON CONFLICT ("messageId") DO UPDATE SET "skipTelegramPublic" = true
    WHERE owner."sessionId" = EXCLUDED."sessionId" AND EXCLUDED."skipTelegramPublic" AND NOT owner."skipTelegramPublic"
  `;
  return tx.wtvMessageOwner.findMany({
    where: { sessionId, messageId: { in: ids } }, select: { messageId: true, skipTelegramPublic: true },
  });
}

export async function prepareWtvMessage(sessionId: string, messageId: string, message: Message, candidates: string[], defer = false) {
  return prisma.$transaction(async tx => {
    await lockWtvMessage(tx, messageId);
    return prepareLockedMessage(tx, sessionId, messageId, message, candidates, defer);
  });
}

async function prepareLockedMessage(tx: Prisma.TransactionClient, sessionId: string, messageId: string, message: Message, candidates: string[], defer: boolean) {
  const where = { sessionId_messageId: { sessionId, messageId } };
  const pending = await tx.wtvPendingMessage.findUnique({ where });
  const posts = await tx.chatPost.findMany({
    where: { streamSessionId: sessionId, rawTwitchMessageId: messageId }, orderBy: [{ postedAt: "asc" }, { id: "asc" }],
    select: { originalUrl: true, normalizedUrl: true, messageText: true, authorName: true, authorTwitchId: true, postedAt: true, skipTelegramPublic: true },
  });
  const original = posts[0] ?? pending ?? message;
  const privateObservation = message.skipTelegramPublic === true || hasSkipTelegramPublicTag(message.messageText) ||
    pending?.skipTelegramPublic === true || hasSkipTelegramPublicTag(pending?.messageText ?? "") ||
    posts.some(post => post.skipTelegramPublic || hasSkipTelegramPublicTag(post.messageText));
  const [owner] = await claimWtvMessages(tx, sessionId, [messageId], privateObservation ? [messageId] : []);
  if (!owner) return null;
  const skipTelegramPublic = owner.skipTelegramPublic;
  const context = { messageText: original.messageText, authorName: original.authorName, authorTwitchId: original.authorTwitchId ?? undefined,
    postedAt: original.postedAt, skipTelegramPublic };
  if (skipTelegramPublic && posts.some(post => !post.skipTelegramPublic)) {
    await tx.chatPost.updateMany({ where: { streamSessionId: sessionId, rawTwitchMessageId: messageId, skipTelegramPublic: false },
      data: { skipTelegramPublic: true } });
  }
  const savedUrls = pending?.sourceUrls ?? [];
  const savedTextUrls = pending ? extractUrls(stripSkipTelegramPublicTag(pending.messageText)).filter(isSupportedMediaCandidateUrl) : [];
  const historical = [...new Set(posts.flatMap(post => extractUrls(stripSkipTelegramPublicTag(post.messageText))))];
  const archived = new Set(posts.map(post => post.normalizedUrl));
  candidates = [...new Set([...savedUrls, ...historical.filter(isSupportedMediaCandidateUrl), ...savedTextUrls, ...candidates])];
  const shortLinks = candidates.filter(isShortLinkUrl);
  let sourceUrls = shortLinks;
  if (posts.length && shortLinks.length) {
    const pins = await tx.wtvRedirect.findMany({ where: { sessionId, messageId } });
    const knownSources = new Set(pins.map(pin => pin.sourceUrl));
    const historicalShorts = new Map(historical.filter(isShortLinkUrl).map(url => [normalizeUrl(url), url]));
    const explainedTargets = new Set([
      ...historical.filter(url => !isShortLinkUrl(url)),
      ...pins.filter(pin => !pin.visitedUrls.length).map(pin => pin.targetUrl),
    ].map(normalizeUrl));
    const legacy = posts.filter(post => !explainedTargets.has(post.normalizedUrl));
    const knownNormalized = new Set(pins.map(pin => normalizeUrl(pin.sourceUrl)));
    const unknown = [...historicalShorts.values()].filter(url => !knownNormalized.has(normalizeUrl(url)) && !savedUrls.includes(url));
    // Old posts have a destination but no source. Never fetch a mutable link
    // again to guess which archived destination it originally represented.
    if (legacy.length === 1 && unknown.length === 1) {
      await pinDestination(tx, sessionId, messageId, unknown[0]!, legacy[0]!.originalUrl);
    }
    sourceUrls = pins.filter(pin => shortLinks.includes(pin.sourceUrl) &&
      (pin.visitedUrls.length > 0 || !archived.has(normalizeUrl(pin.targetUrl)!))).map(pin => pin.sourceUrl);
    // An unpinned historical short may already represent an archived direct URL.
    // Fetch it only if the durable queue had already accepted it.
    sourceUrls.push(...shortLinks.filter(url => !knownSources.has(url) && (savedUrls.includes(url) || !historicalShorts.has(normalizeUrl(url)))));
  }
  const remaining = candidates.filter(url => isShortLinkUrl(url) ? sourceUrls.includes(url) : !archived.has(normalizeUrl(url)!));
  const persist = pending || sourceUrls.length || ((defer || skipTelegramPublic) && remaining.length);
  if (!persist) return { context, candidates: remaining, pending: false };

  // lastAttemptAt orders retries. Observing an edit must not move it behind newer work.
  await tx.wtvPendingMessage.upsert({
    where, create: { sessionId, messageId, sourceUrls: remaining, ...context },
    update: { sourceUrls: remaining, skipTelegramPublic, ...(defer ? {} : { lastAttemptAt: new Date() }) },
  });
  return { context, candidates: remaining, pending: true };
}

export async function resolveWtvRedirect(sessionId: string, messageId: string, sourceUrl: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const key = { sessionId, messageId, sourceUrl };
  const where = { sessionId_messageId_sourceUrl: key };
  const existing = await prisma.wtvRedirect.findUnique({ where });
  return resolveShortLink(sourceUrl, signal, existing, async (previous, next) => {
    if (!previous) return pinDestination(prisma, sessionId, messageId, sourceUrl, next.targetUrl, next.visitedUrls);
    const result = await prisma.wtvRedirect.updateMany({
      where: { ...key, targetUrl: previous.targetUrl, visitedUrls: { equals: previous.visitedUrls } }, data: next,
    });
    if (result.count) return next;
    return prisma.wtvRedirect.findUniqueOrThrow({ where });
  });
}

async function pinDestination(db: Prisma.TransactionClient, sessionId: string, messageId: string, sourceUrl: string, targetUrl: string, visitedUrls: string[] = []) {
  const [pinned] = await db.$queryRaw<[RedirectProgress]>`
    INSERT INTO wtv_redirects ("sessionId", "messageId", "sourceUrl", "targetUrl", "visitedUrls")
    VALUES (${sessionId}, ${messageId}, ${sourceUrl}, ${targetUrl}, ${visitedUrls}::text[])
    ON CONFLICT ("sessionId", "messageId", "sourceUrl") DO UPDATE SET "sourceUrl" = EXCLUDED."sourceUrl"
    RETURNING "targetUrl", "visitedUrls"
  `;
  return pinned;
}
