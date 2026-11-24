import { extractUrls, hasSkipTelegramPublicTag, stripSkipTelegramPublicTag } from "@dawgostan/core";
import type { Prisma, WtvPendingMessage } from "@prisma/client";
import { prisma } from "../prisma.js";
import { twitchChannels, wtvChannels } from "../env.js";
import { isIgnoredChatAuthor, isIgnoredChatCommand } from "./chat-filter.js";
import { ingestChatMessage } from "./twitch.js";
import { isWithinOfflineGrace, offlineGraceMs } from "./stream-grace.js";
import { isSupportedMediaCandidateUrl } from "./redirect-resolver.js";
import { logServiceAlert } from "../alert-log.js";
import { claimWtvMessages, prepareWtvMessage } from "./wtv-short-links.js";
import { runPolls } from "../polling.js";

type WtvProfileResponse = {
  profile: {
    userId: string;
    nickname: string;
  };
};

type WtvChannelResponse = {
  channel: WtvChannel;
};

type WtvChannel = {
  channelId: string;
  name: string;
  live: boolean;
  liveStreamId?: string | null;
  liveStream?: WtvStream | null;
};

type WtvStream = {
  streamId: string;
  title: string;
  state: "started" | "finished" | string;
  startedAt: string;
  finishedAt?: string | null;
  playbackUrl?: string | null;
};

type WtvMessagesResponse = {
  messages: WtvMessage[];
};

type WtvMessage = {
  messageId: string;
  type: string;
  content?: string;
  sender?: {
    userId?: string;
    nickname?: string;
  };
  createdAt: string;
};

type PageMedia = {
  id: string;
  signature: string;
  payload: { authorName: string; authorTwitchId?: string; postedAt: Date; messageText: string; skipTelegramPublic: boolean };
  urls: string[];
  archived: boolean;
};

const profileApiUrl = "https://profiles-service.w.tv/api/v1";
const searchApiUrl = "https://streams-search-service.w.tv/api/v1";
const chatApiUrl = "https://chats-service.w.tv/api/v1";
const wtvUserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const wtvMessagePageSize = 100;
const wtvRetryBatchSize = 4;
const maxConcurrentChannelPolls = 4;
const recentMessageIdsByChannel = new Map(wtvChannels.map((channel) => [channel, new Map<string, string>()]));
const activeChannelPolls = new Map<string, { kind: "poll" | "expiry"; done: Promise<void> }>();
const failedPolls = new Map<string, number>();
const resolvedChannelIds = new Map<string, string>();

export async function pollWtvStreams(signal?: AbortSignal): Promise<void> {
  const tasks = Array.from(recentMessageIdsByChannel, ([channel, recentMessageIds]) => ({
    code: "wtv_task_failed", title: "Не удалось проверить WTV-стримы", component: "wtv",
    run: async () => {
      try {
        await pollWtvChannel(channel, recentMessageIds, signal);
      } catch (error) {
        if (signal?.aborted) return;
        logServiceAlert({ code: "wtv_poll_failed", title: "WTV недоступен", component: "wtv", context: `channel=${channel}`, error });
      }
    },
  }));
  const cleanup = [{ code: "wtv_task_failed", title: "Не удалось очистить завершённые сессии", component: "database", run: cleanupUnconfiguredSessions }];
  const channels = runPolls(tasks, maxConcurrentChannelPolls, signal);
  if (!signal) await channels;
  await Promise.all([channels, runPolls(cleanup, 1, signal)]);
}

async function pollWtvChannel(configuredChannel: string, recentMessageIds: Map<string, string>, signal?: AbortSignal): Promise<void> {
  const timeout = AbortSignal.timeout(15_000);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const startedAt = Date.now();
  try {
    const profile = await fetchWtvProfile(configuredChannel, deadline);
    const login = profile.profile.nickname.toLowerCase();
    const channelId = profile.profile.userId;
    resolvedChannelIds.set(configuredChannel, channelId);
    await withChannelPoll(channelId, "poll", async () => {
      const pageSize = await pollResolvedChannel(login, channelId, recentMessageIds, deadline);
      if (!signal?.aborted) await expireChannelGrace(channelId, Date.now());
      console.log(`[wtv] poll channel=${login} live=${pageSize !== null}${pageSize === null ? "" : ` messages=${pageSize}/${wtvMessagePageSize}`}`);
    });
    failedPolls.delete(configuredChannel);
  } catch (error) {
    if (!signal?.aborted) {
      failedPolls.set(configuredChannel, startedAt);
      await expireAfterFailedPoll(configuredChannel);
    }
    throw error;
  }
}

async function expireAfterFailedPoll(channel: string) {
  const id = resolvedChannelIds.get(channel) ?? (isUuid(channel) ? channel : undefined);
  const stored = await prisma.streamer.findFirst({
    where: id ? { twitchUserId: `wtv:${id}` } : { login: channel, twitchUserId: { startsWith: "wtv:" } },
    select: { login: true, twitchUserId: true },
  });
  if (!stored) return;
  const channelId = stored.twitchUserId.slice(4);
  // A failed nickname lookup must let the UUID (and vice versa) observe a
  // reconnect. Expire only grace periods that elapsed before every failed poll began.
  let checkedAt = Infinity;
  for (const alias of recentMessageIdsByChannel.keys()) {
    if (alias !== channel && alias !== channelId && alias !== stored.login && resolvedChannelIds.get(alias) !== channelId) continue;
    const failedAt = failedPolls.get(alias);
    if (failedAt === undefined) return;
    checkedAt = Math.min(checkedAt, failedAt);
  }
  await withChannelPoll(channelId, "expiry", () => expireChannelGrace(channelId, checkedAt));
}

async function withChannelPoll(channelId: string, kind: "poll" | "expiry", run: () => Promise<void>) {
  const active = activeChannelPolls.get(channelId);
  if (active && (active.kind === "poll" || kind === "expiry")) return active.done;
  // A fresh channel observation must still run after an in-flight expiry.
  const done = active ? active.done.catch(() => undefined).then(run) : run();
  activeChannelPolls.set(channelId, { kind, done });
  try {
    await done;
  } finally {
    if (activeChannelPolls.get(channelId)?.done === done) activeChannelPolls.delete(channelId);
  }
}

async function pollResolvedChannel(login: string, channelId: string, recentMessageIds: Map<string, string>, deadline: AbortSignal): Promise<number | null> {
  const channel = (await fetchWtvChannel(channelId, deadline)).channel;
  const liveStream = channel.liveStream && channel.liveStream.state === "started" && channel.liveStream.playbackUrl ? channel.liveStream : null;

  if (!channel.live || !liveStream) {
    await prisma.streamer.updateMany({
      where: { login },
      data: { lastStatus: "offline", lastCheckedAt: new Date() },
    });
    const streamer = { twitchUserId: `wtv:${channelId}` };
    const sessionUpdate = await prisma.streamSession.updateMany({
      where: { streamer, status: "live", endedAt: null }, data: { endedAt: new Date() },
    });
    if (sessionUpdate.count > 0) console.log(`[wtv] offline login=${login} sessions=${sessionUpdate.count}`);
    const cutoff = new Date(Date.now() - offlineGraceMs);
    const pending = await pendingMessages({ session: { streamer, status: "live", endedAt: { gt: cutoff } } });
    await retryMessages(login, pending, deadline);
    return null;
  }

  const session = await upsertLiveStreamer(channel, liveStream);
  const pending = await pendingMessages({ sessionId: session.id });
  return ingestRecentMessages(login, channelId, session, recentMessageIds, pending, deadline);
}

async function upsertLiveStreamer(channel: WtvChannel, stream: WtvStream) {
  const login = channel.name.toLowerCase();
  const startedAt = parseDate(stream.startedAt);
  const wtvStreamId = `wtv:${stream.streamId}`;
  const streamer = await prisma.streamer.upsert({
    where: { login },
    create: {
      twitchUserId: `wtv:${channel.channelId}`,
      login,
      displayName: channel.name,
      lastStatus: "online",
      lastCheckedAt: new Date(),
    },
    update: {
      twitchUserId: `wtv:${channel.channelId}`,
      displayName: channel.name,
      lastStatus: "online",
      lastCheckedAt: new Date(),
    },
  });

  const active = await prisma.streamSession.findFirst({
    where: { streamerId: streamer.id, status: "live" },
    orderBy: { startedAt: "desc" },
  });

  if (active?.twitchStreamId && active.twitchStreamId !== wtvStreamId && !isWithinOfflineGrace(active.endedAt, startedAt)) {
    await prisma.streamSession.update({
      where: { id: active.id },
      data: { status: "ended", endedAt: startedAt },
    });
  }

  if (active && (!active.twitchStreamId || active.twitchStreamId === wtvStreamId || isWithinOfflineGrace(active.endedAt, startedAt))) {
    await prisma.streamSession.update({
      where: { id: active.id },
      data: {
        twitchStreamId: wtvStreamId,
        title: stream.title,
        startedAt: active.startedAt,
        endedAt: null,
      },
    });
    return { id: active.id, startedAt: active.startedAt };
  }

  const session = await prisma.streamSession.create({
    data: {
      streamerId: streamer.id,
      twitchStreamId: wtvStreamId,
      title: stream.title,
      startedAt,
      status: "live",
    },
    select: { id: true },
  });
  return { id: session.id, startedAt };
}

async function ingestRecentMessages(login: string, channelId: string, session: { id: string; startedAt: Date }, recentMessageIds: Map<string, string>, pending: WtvPendingMessage[], deadline: AbortSignal): Promise<number> {
  let body: WtvMessagesResponse;
  try {
    body = await fetchWtvMessages(channelId, deadline);
  } catch (error) {
    await retryMessages(login, pending, deadline);
    throw error;
  }

  // The API can edit a message without changing its ID. Only identical page entries are cached.
  const page = [...body.messages].reverse().map(message => ({
    message, id: `wtv:${message.messageId}`,
    signature: JSON.stringify([session.id, message.type, message.content, message.sender?.nickname, message.sender?.userId, message.createdAt]),
  })).filter(entry => recentMessageIds.get(entry.id) !== entry.signature);
  const ids = [...new Set(page.map(entry => entry.id))];
  const privateIds = page.filter(({ message }) => hasSkipTelegramPublicTag(cleanWtvMessageText(message.content ?? ""))).map(entry => entry.id);
  if (privateIds.length) {
    // Apply privacy observations to their original broadcast before any URL work.
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT 1 FROM (SELECT DISTINCT unnest(${privateIds}::text[]) AS id ORDER BY id) AS ids,
        LATERAL pg_advisory_xact_lock(hashtextextended(ids.id, 0))`;
      await tx.wtvMessageOwner.updateMany({ where: { messageId: { in: privateIds }, skipTelegramPublic: false }, data: { skipTelegramPublic: true } });
      await tx.wtvPendingMessage.updateMany({ where: { messageId: { in: privateIds }, skipTelegramPublic: false }, data: { skipTelegramPublic: true } });
      await tx.chatPost.updateMany({ where: { rawTwitchMessageId: { in: privateIds }, skipTelegramPublic: false }, data: { skipTelegramPublic: true } });
    });
  }
  const posts = ids.length ? await prisma.chatPost.findMany({
    where: { rawTwitchMessageId: { in: ids } }, orderBy: [{ postedAt: "asc" }, { id: "asc" }],
    select: { rawTwitchMessageId: true, streamSessionId: true, authorTwitchId: true, authorName: true, postedAt: true, messageText: true, skipTelegramPublic: true },
  }) : [];
  const archived = new Map<string, typeof posts[number]>();
  for (const post of posts) {
    const id = post.rawTwitchMessageId;
    if (!id) continue;
    const previous = archived.get(id);
    if (!previous || (previous.streamSessionId !== session.id && post.streamSessionId === session.id)) archived.set(id, post);
  }
  const pendingById = new Map(pending.map(row => [row.messageId, row]));
  if (ids.length && pending.length === wtvRetryBatchSize) {
    const more = await prisma.wtvPendingMessage.findMany({ where: { sessionId: session.id, messageId: { in: ids } } });
    for (const row of more) pendingById.set(row.messageId, row);
  }
  const freshCandidates: PageMedia[] = [];
  const edits: PageMedia[] = [];
  for (const entry of page) {
    const { message, id, signature } = entry;
    const queued = pendingById.get(id);
    const post = archived.get(id);
    if (post && post.streamSessionId !== session.id) continue;
    const messageText = cleanWtvMessageText(message.content ?? "");
    const postedAt = new Date(message.createdAt);
    const edited = message.type === "MESSAGE" && message.sender?.nickname && Number.isFinite(+postedAt) && postedAt >= session.startedAt &&
      !isIgnoredChatAuthor(message.sender.nickname) && !isIgnoredChatCommand(messageText) ? {
        authorName: message.sender.nickname, authorTwitchId: message.sender.userId ? `wtv:${message.sender.userId}` : undefined,
        postedAt, messageText, skipTelegramPublic: hasSkipTelegramPublicTag(messageText),
      } : undefined;
    const urls = edited ? extractUrls(stripSkipTelegramPublicTag(messageText)).filter(isSupportedMediaCandidateUrl) : [];
    const original = post ?? queued ?? (urls.length ? edited : undefined);
    if (!original) {
      rememberMessage(recentMessageIds, id, signature);
      continue;
    }
    const payload = {
      authorName: original.authorName, authorTwitchId: original.authorTwitchId ?? undefined, postedAt: original.postedAt,
      messageText: original.messageText, skipTelegramPublic: hasSkipTelegramPublicTag(messageText) || original.skipTelegramPublic,
    };
    const media = { id, signature, payload, urls, archived: Boolean(post) };
    if (!queued) {
      freshCandidates.push(media);
    } else if (messageText !== queued.messageText || (payload.skipTelegramPublic && !queued.skipTelegramPublic)) {
      edits.push(media);
    }
  }

  // Filter a replayed page in one lookup, including IDs whose retry payloads have expired.
  const foreign = freshCandidates.length ? await prisma.wtvMessageOwner.findMany({
    where: { messageId: { in: freshCandidates.map(entry => entry.id) }, sessionId: { not: session.id } }, select: { messageId: true },
  }) : [];
  const retired = new Set(foreign.map(row => row.messageId));
  const fresh = freshCandidates.filter(({ id, signature }) => {
    if (!retired.has(id)) return true;
    rememberMessage(recentMessageIds, id, signature);
    return false;
  });

  // A failed retry or a deadline must not discard the page we just fetched.
  const staged = pending.length > 0 && fresh.length > 0;
  if (staged) await deferPageMessages(session.id, fresh);
  for (const { id, signature, payload, urls } of edits) {
    await prepareWtvMessage(session.id, id, payload, urls, true);
    rememberMessage(recentMessageIds, id, signature);
  }
  await retryMessages(login, pending, deadline);
  const deferred: PageMedia[] = [];
  for (const entry of fresh) {
    const { id, signature, payload, urls } = entry;
    if (recentMessageIds.get(id) === signature) continue;
    if (!deadline.aborted) {
      await ingestChatMessage({ streamerLogin: login, wtvSessionId: session.id, twitchMessageId: id,
        wtvCandidateUrls: urls, signal: deadline, ...payload });
    }
    if (deadline.aborted && !staged) {
      deferred.push(entry);
    } else {
      rememberMessage(recentMessageIds, id, signature);
    }
  }
  if (deferred.length) {
    await deferPageMessages(session.id, deferred);
    for (const { id, signature } of deferred) rememberMessage(recentMessageIds, id, signature);
  }
  return body.messages.length;
}

async function deferPageMessages(sessionId: string, entries: PageMedia[]) {
  // Save the unattempted page in one batch before yielding the polling slot.
  const fresh = entries.filter(entry => !entry.archived);
  const ids = fresh.map(entry => entry.id);
  const privateIds = fresh.filter(entry => entry.payload.skipTelegramPublic).map(entry => entry.id);
  const handled = new Set<string>();
  if (ids.length) {
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT 1 FROM (SELECT DISTINCT unnest(${ids}::text[]) AS id ORDER BY id) AS ids,
        LATERAL pg_advisory_xact_lock(hashtextextended(ids.id, 0))`;
      const owners = await claimWtvMessages(tx, sessionId, ids, privateIds);
      const byId = new Map(owners.map(owner => [owner.messageId, owner]));
      const data = fresh.flatMap(({ id, payload }) => {
        const owner = byId.get(id);
        if (owner) return [{ sessionId, messageId: id, sourceUrls: [], ...payload, skipTelegramPublic: owner.skipTelegramPublic }];
        handled.add(id);
        return [];
      });
      const inserted = await tx.wtvPendingMessage.createManyAndReturn({ data, skipDuplicates: true, select: { messageId: true } });
      for (const row of inserted) handled.add(row.messageId);
      if (privateIds.length) {
        await tx.wtvPendingMessage.updateMany({ where: { sessionId, messageId: { in: privateIds }, skipTelegramPublic: false },
          data: { skipTelegramPublic: true } });
        await tx.chatPost.updateMany({ where: { streamSessionId: sessionId, rawTwitchMessageId: { in: privateIds }, skipTelegramPublic: false },
          data: { skipTelegramPublic: true } });
      }
    });
  }
  for (const { id, payload, urls } of entries) {
    // A concurrent worker or an older archive row owns the original context.
    if (!handled.delete(id)) await prepareWtvMessage(sessionId, id, payload, urls, true);
  }
}

function rememberMessage(cache: Map<string, string>, id: string, signature: string) {
  if (!cache.has(id) && cache.size === wtvMessagePageSize) cache.delete(cache.keys().next().value!);
  cache.set(id, signature);
}

function pendingMessages(where: Prisma.WtvPendingMessageWhereInput) {
  return prisma.wtvPendingMessage.findMany({ where, orderBy: [{ lastAttemptAt: "asc" }, { messageId: "asc" }], take: wtvRetryBatchSize });
}

async function retryMessages(login: string, messages: WtvPendingMessage[], deadline: AbortSignal) {
  for (const message of messages) {
    if (deadline.aborted) break;
    try {
      await ingestChatMessage({
        streamerLogin: login, wtvSessionId: message.sessionId, twitchMessageId: message.messageId,
        authorName: message.authorName, authorTwitchId: message.authorTwitchId ?? undefined, skipTelegramPublic: message.skipTelegramPublic,
        messageText: message.messageText, postedAt: message.postedAt, wtvCandidateUrls: message.sourceUrls, signal: deadline,
      });
    } catch (error) {
      logServiceAlert({ code: "wtv_retry_failed", title: "Не удалось обработать сообщение WTV", component: "wtv",
        context: `channel=${login} message=${message.messageId}`, error });
    }
  }
}

async function fetchWtvProfile(channel: string, deadline: AbortSignal): Promise<WtvProfileResponse> {
  if (isUuid(channel)) {
    const response = await fetchWtvChannel(channel, deadline);
    return { profile: { userId: response.channel.channelId, nickname: response.channel.name } };
  }
  return fetchWtvJson<WtvProfileResponse>(`${profileApiUrl}/profiles/by-nickname/${encodeURIComponent(channel)}`, channel, deadline);
}

async function fetchWtvChannel(channelId: string, deadline: AbortSignal): Promise<WtvChannelResponse> {
  return fetchWtvJson<WtvChannelResponse>(`${searchApiUrl}/channels/${encodeURIComponent(channelId)}`, channelId, deadline);
}

async function fetchWtvMessages(channelId: string, deadline: AbortSignal): Promise<WtvMessagesResponse> {
  return fetchWtvJson<WtvMessagesResponse>(`${chatApiUrl}/chats/${encodeURIComponent(channelId)}/messages`, channelId, deadline, { limit: String(wtvMessagePageSize) });
}

async function fetchWtvJson<T>(url: string, refererChannel: string, deadline: AbortSignal, query: Record<string, string> = {}): Promise<T> {
  const requestUrl = new URL(url);
  for (const [key, value] of Object.entries({ user_lang: "en", platform: "web", ...query })) {
    requestUrl.searchParams.set(key, value);
  }

  const response = await fetch(requestUrl, {
    signal: deadline,
    headers: {
      accept: "application/json",
      "accept-language": "en-US,en;q=0.9",
      origin: "https://w.tv",
      referer: `https://w.tv/${refererChannel}/`,
      "user-agent": wtvUserAgent,
    },
  });

  if (!response.ok) {
    const action = response.headers.get("x-amzn-waf-action");
    throw new Error(`w.tv API failed: ${response.status}${action ? ` waf=${action}` : ""} body=${await response.text()}`);
  }

  return (await response.json()) as T;
}

async function expireChannelGrace(channelId: string, checkedAt: number): Promise<void> {
  const cutoff = new Date(checkedAt - offlineGraceMs);
  await prisma.streamSession.updateMany({
    where: { streamer: { twitchUserId: `wtv:${channelId}` }, status: "live", endedAt: { lt: cutoff } }, data: { status: "ended" },
  });
}

async function cleanupUnconfiguredSessions(): Promise<void> {
  const cutoff = new Date(Date.now() - offlineGraceMs);
  const ids = [...new Set([...wtvChannels.filter(isUuid), ...resolvedChannelIds.values()])].map(id => `wtv:${id}`);
  await prisma.streamSession.updateMany({
    where: { status: "live", endedAt: { lt: cutoff }, streamer: { NOT: { OR: [
      { twitchUserId: { startsWith: "wtv:" }, OR: [{ login: { in: wtvChannels } }, { twitchUserId: { in: ids } }] },
      { NOT: { twitchUserId: { startsWith: "wtv:" } }, login: { in: twitchChannels } },
    ] } } }, data: { status: "ended" },
  });
  // Old chat pages are ineligible after their original session ends.
  const ended = { session: { status: "ended" as const } };
  await prisma.wtvPendingMessage.deleteMany({ where: ended });
  await prisma.wtvRedirect.deleteMany({ where: ended });
}

function parseDate(value: string): Date {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function cleanWtvMessageText(messageText: string): string {
  let cleaned = messageText;
  for (const url of extractUrls(messageText)) {
    if (isIgnoredWtvStickerUrl(url)) cleaned = cleaned.replace(url, " ");
  }
  return cleaned
    .replace(/\bGSS-media\S*/gi, " ")
    .replace(/\bME-[a-z0-9_-]+\.(?:gif|png|webp|jpe?g)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isIgnoredWtvStickerUrl(rawUrl: string): boolean {
  try {
    const url = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
    return url.hostname.toLowerCase().startsWith("gss-");
  } catch {
    return /^gss-/i.test(rawUrl);
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
