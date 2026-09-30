import tmi from "tmi.js";
import WebSocket from "ws";
import { extractUrls, normalizeUrl } from "@dawgostan/core";
import { prisma } from "../prisma.js";
import { env, privateStreamerLogins } from "../env.js";
import { hasSkipTelegramPublicTag, isIgnoredChatAuthor, isIgnoredChatCommand, stripSkipTelegramPublicTag } from "./chat-filter.js";
import { isWithinOfflineGrace, offlineGraceMs } from "./stream-grace.js";
import { publishDeletedChatMessage, publishStoredTelegramMedia } from "./telegram-storage.js";
import { isSupportedMediaCandidateUrl, resolveSupportedMediaUrl } from "./redirect-resolver.js";

type TwitchStream = {
  id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  title: string;
  started_at: string;
};

type EventSubMessage = {
  metadata: { message_type: string; subscription_type?: string; message_timestamp?: string };
  payload: {
    session?: { id: string };
    event?: EventSubEvent;
  };
};

type EventSubEvent = {
  broadcaster_user_id: string;
  broadcaster_user_login: string;
  broadcaster_user_name: string;
  target_user_id?: string;
  target_user_login?: string;
  target_user_name?: string;
  message_id?: string;
  id?: string;
  title?: string;
  started_at?: string;
};

let appToken: { value: string; expiresAt: number } | null = null;
let chatClient: InstanceType<typeof tmi.Client> | null = null;
let chatConnecting = false;
let eventSubSocket: WebSocket | null = null;
let lastChatMessageCleanupAt = 0;
const chatMessageCleanupIntervalMs = 5 * 60 * 1000;

export async function pollTwitchStreams(): Promise<void> {
  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET || channelLogins().length === 0) return;
  const token = await getAppToken();
  await syncConfiguredStreamers(token);
  const params = new URLSearchParams();
  for (const login of channelLogins()) params.append("user_login", login);
  const response = await fetch(`https://api.twitch.tv/helix/streams?${params}`, {
    headers: { "Client-ID": env.TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Twitch streams failed: ${response.status} ${await response.text()}`);
  const body = (await response.json()) as { data: TwitchStream[] };
  const liveLogins = new Set(body.data.map((stream) => stream.user_login.toLowerCase()));
  console.log(`[twitch] poll channels=${channelLogins().join(",")} live=${[...liveLogins].join(",") || "none"}`);

  for (const stream of body.data) {
    await upsertLiveStreamer(stream);
  }

  for (const login of channelLogins()) {
    if (!liveLogins.has(login)) {
      const streamerUpdate = await prisma.streamer.updateMany({
        where: { login },
        data: { lastStatus: "offline", lastCheckedAt: new Date() },
      });
      const sessionUpdate = await markStreamerOffline(login);
      console.log(`[twitch] offline login=${login} streamers=${streamerUpdate.count} sessions=${sessionUpdate.count}`);
    }
  }

  await finalizeExpiredGraceSessions();
}

export function ensureEventSubConnected(): void {
  if (eventSubSocket || !eventSubEnabled() || !env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET || channelLogins().length === 0) return;

  console.log("[eventsub] connecting websocket");
  eventSubSocket = new WebSocket("wss://eventsub.wss.twitch.tv/ws");
  eventSubSocket.on("message", (raw) => {
    void handleEventSubMessage(String(raw)).catch((error) => console.error("EventSub error", error));
  });
  eventSubSocket.on("close", () => {
    console.log("[eventsub] websocket closed");
    eventSubSocket = null;
    setTimeout(ensureEventSubConnected, 10_000);
  });
  eventSubSocket.on("error", (error) => {
    console.error("EventSub socket error", error);
    eventSubSocket?.close();
  });
}

export async function ensureChatConnected(): Promise<void> {
  const channels = channelLogins();
  if (chatClient || chatConnecting || channels.length === 0) return;

  chatConnecting = true;
  console.log(`[chat] connecting channels=${channels.join(",")}`);
  const useAuthenticatedChat = Boolean(env.TWITCH_BOT_USERNAME && env.TWITCH_BOT_OAUTH);
  chatClient = createChatClient(channels, useAuthenticatedChat);
  attachChatHandlers(chatClient);

  try {
    await chatClient.connect();
    console.log(`[chat] connected mode=${useAuthenticatedChat ? "authenticated" : "anonymous"}`);
  } catch (error) {
    const message = errorMessage(error);
    if (useAuthenticatedChat && /login authentication failed/i.test(message)) {
      console.warn("[chat] authenticated connect failed; retrying anonymous");
      await disconnectChatClient(chatClient);
      chatClient = createChatClient(channels, false);
      attachChatHandlers(chatClient);
      await chatClient.connect();
      console.log("[chat] connected mode=anonymous");
      return;
    }

    chatClient = null;
    console.error("[chat] connect failed", error);
    throw error;
  } finally {
    chatConnecting = false;
  }
}

function createChatClient(channels: string[], authenticated: boolean): InstanceType<typeof tmi.Client> {
  return new tmi.Client({
    ...(authenticated ? { identity: { username: env.TWITCH_BOT_USERNAME!, password: env.TWITCH_BOT_OAUTH! } } : {}),
    channels: [...channels],
    connection: { reconnect: true, secure: true },
  });
}

function attachChatHandlers(client: InstanceType<typeof tmi.Client>): void {
  client.on("message", async (channel: string, tags: Record<string, string | undefined>, message: string, self: boolean) => {
    const login = channel.replace(/^#/, "").toLowerCase();
    const authorName = tags["display-name"] ?? tags.username ?? "unknown";
    const urls = extractUrls(message);
    const mediaUrls = urls.filter(isSupportedMediaCandidateUrl);
    if (urls.length > 0) {
      const preview = message.replace(/\s+/g, " ").slice(0, 200);
      console.log(`[chat] message channel=${login} author=${authorName} self=${self} urls=${urls.length} media=${mediaUrls.length} text=${JSON.stringify(preview)}`);
    }

    try {
      await recordChatMessage({
        streamerLogin: login,
        twitchMessageId: tags.id,
        authorTwitchId: tags["user-id"],
        authorLogin: tags.username,
        authorName,
        messageText: message,
        postedAt: new Date(),
      }).catch((error) => {
        console.error("Failed to record chat message", error);
      });
      await ingestChatMessage({
        streamerLogin: login,
        twitchMessageId: tags.id,
        authorTwitchId: tags["user-id"],
        authorName,
        messageText: message,
        postedAt: new Date(),
      });
    } catch (error) {
      console.error("Failed to ingest chat message", error);
    }
  });
  const chatEvents = client as unknown as {
    on(event: "disconnected", handler: (reason: string) => void): void;
    on(event: "reconnect", handler: () => void): void;
    on(event: "notice", handler: (channel: string, msgid: string, message: string) => void): void;
  };
  chatEvents.on("disconnected", (reason: string) => console.warn(`[chat] disconnected reason=${reason}`));
  chatEvents.on("reconnect", () => console.warn("[chat] reconnecting"));
  chatEvents.on("notice", (channel: string, msgid: string, message: string) => {
    console.warn(`[chat] notice channel=${channel} msgid=${msgid} message=${message}`);
  });
}

async function disconnectChatClient(client: InstanceType<typeof tmi.Client>): Promise<void> {
  const disconnect = (client as unknown as { disconnect?: () => Promise<unknown> }).disconnect;
  if (!disconnect) return;
  await disconnect.call(client).catch(() => undefined);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function handleEventSubMessage(raw: string): Promise<void> {
  const message = JSON.parse(raw) as EventSubMessage;

  if (message.metadata.message_type === "session_welcome" && message.payload.session?.id) {
    console.log("[eventsub] session welcome");
    await subscribeEventSub(message.payload.session.id);
    return;
  }

  if (message.metadata.message_type !== "notification" || !message.payload.event) return;
  const event = message.payload.event;
  const login = event.broadcaster_user_login.toLowerCase();

  if (message.metadata.subscription_type === "stream.online") {
    console.log(`[eventsub] stream.online ${login}`);
    const streamer = await prisma.streamer.upsert({
      where: { login },
      create: {
        twitchUserId: event.broadcaster_user_id,
        login,
        displayName: event.broadcaster_user_name,
        lastStatus: "online",
        lastCheckedAt: new Date(),
      },
      update: { lastStatus: "online", lastCheckedAt: new Date(), displayName: event.broadcaster_user_name },
    });
    const active = await prisma.streamSession.findFirst({ where: { streamerId: streamer.id, status: "live" } });
    if (active && (!active.twitchStreamId || active.twitchStreamId === event.id || isWithinOfflineGrace(active.endedAt, event.started_at ? new Date(event.started_at) : new Date()))) {
      await prisma.streamSession.update({
        where: { id: active.id },
        data: {
          twitchStreamId: active.twitchStreamId ?? event.id,
          title: event.title,
          endedAt: null,
        },
      });
    } else {
      if (active) {
        await prisma.streamSession.update({
          where: { id: active.id },
          data: { status: "ended", endedAt: event.started_at ? new Date(event.started_at) : new Date() },
        });
      }
      await prisma.streamSession.create({
        data: {
          streamerId: streamer.id,
          twitchStreamId: event.id,
          title: event.title,
          startedAt: event.started_at ? new Date(event.started_at) : new Date(),
          status: "live",
        },
      });
    }
  }

  if (message.metadata.subscription_type === "stream.offline") {
    console.log(`[eventsub] stream.offline ${login}`);
    await prisma.streamer.updateMany({ where: { login }, data: { lastStatus: "offline", lastCheckedAt: new Date() } });
    await markStreamerOffline(login);
  }

  if (message.metadata.subscription_type === "channel.chat.message_delete") {
    await handleChatMessageDeleteEvent(event, parseEventSubTimestamp(message.metadata.message_timestamp));
  }
}

async function subscribeEventSub(sessionId: string): Promise<void> {
  const token = env.TWITCH_EVENTSUB_USER_TOKEN || (await getAppToken());
  const streamers = await prisma.streamer.findMany({ where: { enabled: true, login: { in: channelLogins() } } });
  const specs = streamers.flatMap((streamer) => eventSubSubscriptionSpecs(streamer.twitchUserId));
  const results = await Promise.all(
    specs.map(async (spec) => {
      const response = await fetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
        method: "POST",
        headers: {
          "Client-ID": env.TWITCH_CLIENT_ID ?? "",
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...spec,
          transport: { method: "websocket", session_id: sessionId },
        }),
      });
      return { response, spec, body: response.ok ? "" : await response.text() };
    }),
  );
  const failed = results.filter((result) => !result.response.ok);
  for (const result of failed) {
    console.warn(`[eventsub] subscribe failed type=${result.spec.type} status=${result.response.status} body=${result.body}`);
  }
  console.log(`[eventsub] subscriptions requested=${results.length} failed=${failed.length}`);
}

export function eventSubSubscriptionSpecs(broadcasterUserId: string): Array<{ type: string; version: string; condition: Record<string, string> }> {
  if (eventSubEnabled()) {
    return [
      {
        type: "channel.chat.message_delete",
        version: "1",
        condition: {
          broadcaster_user_id: broadcasterUserId,
          user_id: env.TWITCH_EVENTSUB_USER_ID!,
        },
      },
    ];
  }

  return [];
}

function eventSubEnabled(): boolean {
  return Boolean(env.TELEGRAM_DELETED_CHANNEL_ID && env.TWITCH_EVENTSUB_USER_TOKEN && env.TWITCH_EVENTSUB_USER_ID);
}

async function handleChatMessageDeleteEvent(event: EventSubEvent, deletedAt: Date): Promise<void> {
  if (!event.message_id) return;
  if (!env.TELEGRAM_DELETED_CHANNEL_ID) return;

  const login = event.broadcaster_user_login.toLowerCase();
  if (privateStreamerLogins.has(login)) {
    console.log(`[eventsub] skip deleted message private_streamer=${login}`);
    return;
  }

  const streamer = await prisma.streamer.findUnique({ where: { login } });
  if (!streamer) {
    console.warn(`[eventsub] deleted message ignored unknown-streamer login=${login}`);
    return;
  }

  const session = await getActiveOrGraceSession(streamer.id, deletedAt);
  if (!session) {
    console.log(`[eventsub] deleted message ignored offline channel=${login}`);
    return;
  }

  const twitchMessageId = event.message_id;
  const existing = await prisma.deletedChatMessage.findUnique({
    where: { streamerId_twitchMessageId: { streamerId: streamer.id, twitchMessageId } },
  });
  if (existing?.telegramMessageId) {
    console.log(`[eventsub] deleted message duplicate channel=${login} message=${twitchMessageId}`);
    return;
  }
  const storedMessage = await prisma.twitchChatMessage.findUnique({
    where: { streamerId_twitchMessageId: { streamerId: streamer.id, twitchMessageId } },
  });
  const messageText = storedMessage?.messageText ?? "[message text unavailable]";
  const authorTwitchId = storedMessage?.authorTwitchId ?? event.target_user_id;
  const authorLogin = storedMessage?.authorLogin ?? event.target_user_login;
  const authorName = storedMessage?.authorName ?? event.target_user_name ?? event.target_user_login ?? "unknown";
  const skipTelegramPublic = hasSkipTelegramPublicTag(messageText);

  if (existing?.skipTelegramPublic) {
    console.log(`[eventsub] skip deleted message user_tag channel=${login} message=${twitchMessageId}`);
    return;
  }

  let canPublish = false;
  if (existing) {
    canPublish = existing.updatedAt.getTime() < Date.now() - 5 * 60 * 1000;
    if (!canPublish) {
      console.log(`[eventsub] deleted message publish already pending channel=${login} message=${twitchMessageId}`);
      return;
    }
  } else {
    try {
      await prisma.deletedChatMessage.create({
        data: {
          streamerId: streamer.id,
          streamSessionId: session.id,
          twitchMessageId,
          authorTwitchId,
          authorLogin,
          authorName,
          messageText,
          skipTelegramPublic,
          deletedAt,
        },
      });
      canPublish = true;
    } catch (error) {
      const duplicate = await prisma.deletedChatMessage.findUnique({
        where: { streamerId_twitchMessageId: { streamerId: streamer.id, twitchMessageId } },
      });
      if (duplicate) return;
      throw error;
    }
  }

  if (!canPublish) return;

  const linkedPosts = await findPostsForRawTwitchMessage(session.id, twitchMessageId);
  if (skipTelegramPublic || linkedPosts.some((post) => post.skipTelegramPublic || post.asset?.visibility === "hidden")) {
    console.log(`[eventsub] skip deleted message public_suppressed channel=${login} message=${twitchMessageId}`);
    await prisma.deletedChatMessage.update({
      where: { streamerId_twitchMessageId: { streamerId: streamer.id, twitchMessageId } },
      data: { skipTelegramPublic: true },
    });
    return;
  }
  const published = await publishDeletedChatMessage({
    streamerLogin: streamer.login,
    streamStartedAt: session.startedAt,
    authorName,
    authorLogin,
    messageText,
    twitchMessageId,
    linkedPosts,
  });

  await prisma.deletedChatMessage.update({
    where: { streamerId_twitchMessageId: { streamerId: streamer.id, twitchMessageId } },
    data: {
      streamerId: streamer.id,
      streamSessionId: session.id,
      twitchMessageId,
      authorTwitchId,
      authorLogin,
      authorName,
      messageText,
      skipTelegramPublic: false,
      deletedAt,
      telegramChatId: published?.telegramChatId,
      telegramMessageId: published?.telegramMessageId,
    },
  });
}

export async function recordChatMessage(input: {
  streamerLogin: string;
  twitchMessageId?: string;
  authorTwitchId?: string;
  authorLogin?: string;
  authorName: string;
  messageText: string;
  postedAt: Date;
}): Promise<void> {
  if (!input.twitchMessageId) return;
  if (isIgnoredChatAuthor(input.authorName) || isIgnoredChatCommand(input.messageText)) return;

  const streamer = await prisma.streamer.findUnique({ where: { login: input.streamerLogin } });
  if (!streamer) return;

  const session = await getActiveOrGraceSession(streamer.id, input.postedAt);
  if (!session) return;

  await prisma.twitchChatMessage.upsert({
    where: { streamerId_twitchMessageId: { streamerId: streamer.id, twitchMessageId: input.twitchMessageId } },
    create: {
      streamerId: streamer.id,
      streamSessionId: session.id,
      twitchMessageId: input.twitchMessageId,
      authorTwitchId: input.authorTwitchId,
      authorLogin: input.authorLogin,
      authorName: input.authorName,
      messageText: input.messageText,
      postedAt: input.postedAt,
    },
    update: {
      streamSessionId: session.id,
      authorTwitchId: input.authorTwitchId,
      authorLogin: input.authorLogin,
      authorName: input.authorName,
      messageText: input.messageText,
      postedAt: input.postedAt,
    },
  });
}

export async function cleanupExpiredChatMessages(now = new Date()): Promise<number> {
  const retentionMinutes = Math.max(1, env.TWITCH_CHAT_MESSAGE_RETENTION_MINUTES);
  if (Date.now() - lastChatMessageCleanupAt < chatMessageCleanupIntervalMs) return 0;
  lastChatMessageCleanupAt = Date.now();

  const cutoff = new Date(now.getTime() - retentionMinutes * 60 * 1000);
  const result = await prisma.twitchChatMessage.deleteMany({ where: { postedAt: { lt: cutoff } } });
  if (result.count > 0) console.log(`[chat] cleaned expired messages count=${result.count} cutoff=${cutoff.toISOString()}`);
  return result.count;
}

export async function ingestChatMessage(input: {
  streamerLogin: string;
  twitchMessageId?: string;
  authorTwitchId?: string;
  authorName: string;
  messageText: string;
  postedAt: Date;
  skipTelegramPublic?: boolean;
}): Promise<void> {
  if (isIgnoredChatAuthor(input.authorName)) {
    console.log(`[chat] ignored author channel=${input.streamerLogin} author=${input.authorName}`);
    return;
  }

  if (isIgnoredChatCommand(input.messageText)) {
    console.log(`[chat] ignored command channel=${input.streamerLogin} author=${input.authorName}`);
    return;
  }

  const skipTelegramPublic = input.skipTelegramPublic === true || hasSkipTelegramPublicTag(input.messageText);
  const urls = extractUrls(skipTelegramPublic ? stripSkipTelegramPublicTag(input.messageText) : input.messageText).filter(isSupportedMediaCandidateUrl);
  if (urls.length === 0) return;

  const streamer = await prisma.streamer.findUnique({ where: { login: input.streamerLogin } });
  if (!streamer) {
    console.warn(`[chat] ignored unknown-streamer login=${input.streamerLogin}`);
    return;
  }

  const session = await getActiveOrGraceSession(streamer.id, input.postedAt);
  if (!session) {
    console.log(`[chat] ignored offline media channel=${input.streamerLogin}`);
    return;
  }

  for (const candidateUrl of urls) {
    const rawUrl = await resolveSupportedMediaUrl(candidateUrl);
    if (!rawUrl) continue;
    const normalizedUrl = normalizeUrl(rawUrl);
    if (!normalizedUrl) continue;
    console.log(`[chat] media-url author=${input.authorName} url=${rawUrl} normalized=${normalizedUrl}`);

    const blocked = await prisma.blockedMedia.findUnique({ where: { normalizedUrl } });
    if (blocked) {
      await prisma.chatPost.create({
        data: {
          streamSessionId: session.id,
          twitchMessageId: input.twitchMessageId ? `${input.twitchMessageId}:${normalizedUrl}` : undefined,
          rawTwitchMessageId: input.twitchMessageId,
          authorTwitchId: input.authorTwitchId,
          authorName: input.authorName,
          messageText: input.messageText,
          originalUrl: rawUrl,
          normalizedUrl,
          postedAt: input.postedAt,
          skipTelegramPublic,
          status: "blocked",
        },
      });
      continue;
    }

    const existingAsset = await prisma.asset.findUnique({ where: { normalizedUrl } });
    const reusableAsset = existingAsset?.status === "stored" ? existingAsset : await findStoredAssetForNormalizedUrl(normalizedUrl);
    const post = await prisma.chatPost.create({
      data: {
        streamSessionId: session.id,
        twitchMessageId: input.twitchMessageId ? `${input.twitchMessageId}:${normalizedUrl}` : undefined,
        rawTwitchMessageId: input.twitchMessageId,
        authorTwitchId: input.authorTwitchId,
        authorName: input.authorName,
        messageText: input.messageText,
        originalUrl: rawUrl,
        normalizedUrl,
        postedAt: input.postedAt,
        assetId: reusableAsset?.id ?? existingAsset?.id,
        skipTelegramPublic,
        status: reusableAsset ? "stored" : "pending",
      },
    });

    if (reusableAsset) {
      console.log(`[download] reused asset=${reusableAsset.id} chatPost=${post.id}`);
      await publishStoredTelegramMedia(reusableAsset, {
        streamerLogin: streamer.login,
        streamStartedAt: session.startedAt,
        authorName: input.authorName,
        messageText: input.messageText,
        skipTelegramPublic,
      });
    } else {
      const asset =
        existingAsset ??
        (await prisma.asset.upsert({
          where: { normalizedUrl },
          update: {},
          create: {
            originalUrl: rawUrl,
            normalizedUrl,
            mediaType: "other",
            status: "pending",
          },
        }));

      const activeJob = await prisma.downloadJob.findFirst({
        where: {
          assetId: asset.id,
          status: { in: ["pending", "running"] },
        },
      });

      if (activeJob) {
        await prisma.chatPost.update({ where: { id: post.id }, data: { assetId: asset.id } });
        console.log(`[download] duplicate pending asset=${asset.id} chatPost=${post.id}`);
        continue;
      }

      await prisma.downloadJob.create({
        data: {
          assetId: asset.id,
          chatPostId: post.id,
          url: rawUrl,
          status: "pending",
        },
      });
      console.log(`[download] queued chatPost=${post.id} asset=${asset.id}`);
    }
  }
}

async function findStoredAssetForNormalizedUrl(normalizedUrl: string) {
  const post = await prisma.chatPost.findFirst({
    where: {
      normalizedUrl,
      status: "stored",
      asset: { status: "stored" },
    },
    orderBy: { postedAt: "asc" },
    include: { asset: true },
  });
  return post?.asset ?? null;
}

async function findPostsForRawTwitchMessage(streamSessionId: string, twitchMessageId: string) {
  return prisma.chatPost.findMany({
    where: {
      streamSessionId,
      OR: [{ rawTwitchMessageId: twitchMessageId }, { twitchMessageId: { startsWith: `${twitchMessageId}:` } }],
    },
    orderBy: { postedAt: "asc" },
    include: { asset: true },
  });
}

function parseEventSubTimestamp(value: string | undefined): Date {
  if (!value) return new Date();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

async function syncConfiguredStreamers(token: string): Promise<void> {
  const params = new URLSearchParams();
  const logins = channelLogins();
  for (const login of logins) params.append("login", login);
  const response = await fetch(`https://api.twitch.tv/helix/users?${params}`, {
    headers: { "Client-ID": env.TWITCH_CLIENT_ID ?? "", Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Twitch users failed: ${response.status} channels=${logins.join(",")} body=${await response.text()}`);
  const body = (await response.json()) as { data: Array<{ id: string; login: string; display_name: string }> };
  console.log(`[twitch] synced users=${body.data.map((user) => user.login).join(",") || "none"}`);
  for (const user of body.data) {
    await prisma.streamer.upsert({
      where: { login: user.login.toLowerCase() },
      create: {
        twitchUserId: user.id,
        login: user.login.toLowerCase(),
        displayName: user.display_name,
        lastStatus: "unknown",
        lastCheckedAt: new Date(),
      },
      update: {
        twitchUserId: user.id,
        displayName: user.display_name,
      },
    });
  }
}

function channelLogins(): string[] {
  return env.TWITCH_CHANNELS.split(",")
    .map((login) => login.trim().toLowerCase().replace(/^#+/, ""))
    .filter(Boolean);
}

async function getActiveOrGraceSession(streamerId: string, seenAt: Date) {
  const active = await prisma.streamSession.findFirst({
    where: {
      streamerId,
      status: "live",
      OR: [{ endedAt: null }, { endedAt: { gte: new Date(seenAt.getTime() - offlineGraceMs) } }],
    },
    orderBy: { startedAt: "desc" },
  });
  return active;
}

async function upsertLiveStreamer(stream: TwitchStream): Promise<void> {
  const streamer = await prisma.streamer.upsert({
    where: { login: stream.user_login.toLowerCase() },
    create: {
      twitchUserId: stream.user_id,
      login: stream.user_login.toLowerCase(),
      displayName: stream.user_name,
      lastStatus: "online",
      lastCheckedAt: new Date(),
    },
    update: {
      twitchUserId: stream.user_id,
      displayName: stream.user_name,
      lastStatus: "online",
      lastCheckedAt: new Date(),
    },
  });

  const active = await prisma.streamSession.findFirst({
    where: { streamerId: streamer.id, status: "live" },
    orderBy: { startedAt: "desc" },
  });

  if (active?.twitchStreamId && active.twitchStreamId !== stream.id && !isWithinOfflineGrace(active.endedAt, new Date(stream.started_at))) {
    await prisma.streamSession.update({
      where: { id: active.id },
      data: { status: "ended", endedAt: new Date(stream.started_at) },
    });
  }

  if (active && (!active.twitchStreamId || active.twitchStreamId === stream.id || isWithinOfflineGrace(active.endedAt, new Date(stream.started_at)))) {
    await prisma.streamSession.update({
      where: { id: active.id },
      data: {
        twitchStreamId: active.twitchStreamId ?? stream.id,
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
      twitchStreamId: stream.id,
      title: stream.title,
      startedAt: new Date(stream.started_at),
      status: "live",
    },
  });
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
  if (update.count > 0) console.log(`[twitch] finalized grace sessions=${update.count}`);
}

async function getAppToken(): Promise<string> {
  if (appToken && appToken.expiresAt > Date.now() + 60_000) return appToken.value;
  const response = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID ?? "",
      client_secret: env.TWITCH_CLIENT_SECRET ?? "",
      grant_type: "client_credentials",
    }),
  });
  if (!response.ok) throw new Error(`Twitch token failed: ${response.status}`);
  const body = (await response.json()) as { access_token: string; expires_in: number };
  appToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return appToken.value;
}
