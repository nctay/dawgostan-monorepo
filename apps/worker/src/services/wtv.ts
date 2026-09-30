import { extractUrls } from "@dawgostan/core";
import { prisma } from "../prisma.js";
import { wtvChannels } from "../env.js";
import { ingestChatMessage } from "./twitch.js";
import { isWithinOfflineGrace, offlineGraceMs } from "./stream-grace.js";
import { isSupportedMediaCandidateUrl } from "./redirect-resolver.js";

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

const profileApiUrl = "https://profiles-service.w.tv/api/v1";
const searchApiUrl = "https://streams-search-service.w.tv/api/v1";
const chatApiUrl = "https://chats-service.w.tv/api/v1";
const wtvUserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const wtvMessageSeenIds = new Set<string>();

export async function pollWtvStreams(): Promise<void> {
  if (wtvChannels.length === 0) return;

  const liveLogins: string[] = [];
  for (const channel of wtvChannels) {
    try {
      const live = await pollWtvChannel(channel);
      if (live) liveLogins.push(live);
    } catch (error) {
      console.error(`[wtv] poll failed channel=${channel}`, error);
    }
  }

  console.log(`[wtv] poll channels=${wtvChannels.join(",")} live=${liveLogins.join(",") || "none"}`);
  await finalizeExpiredGraceSessions();
}

async function pollWtvChannel(configuredChannel: string): Promise<string | null> {
  const profile = await fetchWtvProfile(configuredChannel);
  const login = profile.profile.nickname.toLowerCase();
  const channelId = profile.profile.userId;
  const channel = (await fetchWtvChannel(channelId)).channel;
  const liveStream = channel.liveStream && channel.liveStream.state === "started" && channel.liveStream.playbackUrl ? channel.liveStream : null;

  if (!channel.live || !liveStream) {
    await prisma.streamer.updateMany({
      where: { login },
      data: { lastStatus: "offline", lastCheckedAt: new Date() },
    });
    const sessionUpdate = await markStreamerOffline(login);
    if (sessionUpdate.count > 0) console.log(`[wtv] offline login=${login} sessions=${sessionUpdate.count}`);
    return null;
  }

  await upsertLiveStreamer(channel, liveStream);
  await ingestRecentMessages(login, channelId);
  return login;
}

async function upsertLiveStreamer(channel: WtvChannel, stream: WtvStream): Promise<void> {
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
        twitchStreamId: active.twitchStreamId ?? wtvStreamId,
        title: stream.title,
        startedAt: active.startedAt,
        endedAt: null,
      },
    });
    return;
  }

  await prisma.streamSession.create({
    data: {
      streamerId: streamer.id,
      twitchStreamId: wtvStreamId,
      title: stream.title,
      startedAt,
      status: "live",
    },
  });
}

async function ingestRecentMessages(login: string, channelId: string): Promise<void> {
  const body = await fetchWtvMessages(channelId);
  for (const message of [...body.messages].reverse()) {
    if (message.type !== "MESSAGE" || !message.content || !message.sender?.nickname) continue;
    const messageText = cleanWtvMessageText(message.content);
    if (!extractUrls(messageText).some(isSupportedMediaCandidateUrl)) {
      wtvMessageSeenIds.add(message.messageId);
      continue;
    }

    const sourceMessageId = `wtv:${message.messageId}`;
    if (wtvMessageSeenIds.has(message.messageId)) continue;
    const existingPost = await prisma.chatPost.findFirst({ where: { rawTwitchMessageId: sourceMessageId } });
    if (existingPost) {
      wtvMessageSeenIds.add(message.messageId);
      continue;
    }

    await ingestChatMessage({
      streamerLogin: login,
      twitchMessageId: sourceMessageId,
      authorTwitchId: message.sender.userId ? `wtv:${message.sender.userId}` : undefined,
      authorName: message.sender.nickname,
      messageText,
      postedAt: parseDate(message.createdAt),
    });
    wtvMessageSeenIds.add(message.messageId);
  }
}

async function fetchWtvProfile(channel: string): Promise<WtvProfileResponse> {
  if (isUuid(channel)) {
    const response = await fetchWtvJson<WtvChannelResponse>(`${searchApiUrl}/channels/${channel}`, channel);
    return { profile: { userId: response.channel.channelId, nickname: response.channel.name } };
  }
  return fetchWtvJson<WtvProfileResponse>(`${profileApiUrl}/profiles/by-nickname/${encodeURIComponent(channel)}`, channel);
}

async function fetchWtvChannel(channelId: string): Promise<WtvChannelResponse> {
  return fetchWtvJson<WtvChannelResponse>(`${searchApiUrl}/channels/${encodeURIComponent(channelId)}`, channelId);
}

async function fetchWtvMessages(channelId: string): Promise<WtvMessagesResponse> {
  return fetchWtvJson<WtvMessagesResponse>(`${chatApiUrl}/chats/${encodeURIComponent(channelId)}/messages`, channelId, { limit: "100" });
}

async function fetchWtvJson<T>(url: string, refererChannel: string, query: Record<string, string> = {}): Promise<T> {
  const requestUrl = new URL(url);
  for (const [key, value] of Object.entries({ user_lang: "en", platform: "web", ...query })) {
    requestUrl.searchParams.set(key, value);
  }

  const response = await fetch(requestUrl, {
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

async function markStreamerOffline(login: string) {
  return prisma.streamSession.updateMany({
    where: { streamer: { login }, status: "live", endedAt: null },
    data: { endedAt: new Date() },
  });
}

async function finalizeExpiredGraceSessions(): Promise<void> {
  const cutoff = new Date(Date.now() - offlineGraceMs);
  const update = await prisma.streamSession.updateMany({
    where: { status: "live", endedAt: { lt: cutoff } },
    data: { status: "ended" },
  });
  if (update.count > 0) console.log(`[wtv] finalized grace sessions=${update.count}`);
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
