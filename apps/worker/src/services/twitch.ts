import tmi from "tmi.js";
import WebSocket from "ws";
import { Prisma } from "@prisma/client";
import { extractUrls, normalizeUrl, toUrl } from "@dawgostan/core";
import { prisma } from "../prisma.js";
import { env, privateStreamerLogins } from "../env.js";
import { hasSkipTelegramPublicTag, isIgnoredChatAuthor, isIgnoredChatCommand, stripSkipTelegramPublicTag } from "./chat-filter.js";
import { prepareWtvMessage, resolveWtvRedirect } from "./wtv-short-links.js";
import { saveChatMediaPost } from "./chat-media-post.js";
import { isWithinOfflineGrace, offlineGraceMs } from "./stream-grace.js";
import { publishDeletedChatMessage, publishStoredTelegramMedia } from "./telegram-storage.js";
import { isShortLinkUrl, isSupportedMediaCandidateUrl, resolveSupportedMediaUrl, TemporaryShortLinkError } from "./redirect-resolver.js";
import { logServiceAlert } from "../alert-log.js";

type TwitchStream = {
  id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  title: string;
  started_at: string;
};

type ChatMessageInput = {
  streamerLogin: string;
  twitchMessageId?: string;
  authorTwitchId?: string;
  authorLogin?: string;
  authorName: string;
  messageText: string;
  postedAt: Date;
  skipTelegramPublic?: boolean;
  wtvSessionId?: string;
  wtvCandidateUrls?: string[];
  signal?: AbortSignal;
};

type ChatMessageContext = {
  streamSessionId: string | null;
  startedAt: Date | null;
  youtubeDisabledUntil: Date | null;
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
let nextChatMembershipCheckAt = 0;
let nextProfileSyncAt = 0;
const profileSyncIntervalMs = 60 * 60 * 1000;
const twitchRequestTimeoutMs = 15_000;
let eventSubSocket: WebSocket | null = null;
const twitchEvents = new Set<Promise<void>>();
const twitchShutdown = new AbortController();
let lastChatMessageCleanupAt = 0;
const chatMessageCleanupIntervalMs = 5 * 60 * 1000;
const chatMembershipCheckIntervalMs = 15_000;
const chatInitialJoinIntervalMs = 2_000;

function twitchDeadline(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(twitchRequestTimeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function pollTwitchStreams(signal?: AbortSignal): Promise<void> {
  const logins = channelLogins();
  if (!logins.length) return;
  try {
    if (env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET) await refreshTwitchStreams(signal);
  } finally {
    if (!signal?.aborted) await finalizeExpiredGraceSessions(logins);
  }
}

async function refreshTwitchStreams(signal?: AbortSignal): Promise<void> {
  const token = await getAppToken(signal);
  if (Date.now() >= nextProfileSyncAt) {
    try {
      await syncConfiguredStreamers(token, signal);
      nextProfileSyncAt = Date.now() + profileSyncIntervalMs;
    } catch (error) {
      if (signal?.aborted) return;
      logServiceAlert({ code: "twitch_profile_sync_failed", title: "Не удалось обновить профили Twitch", component: "twitch", error });
    }
  }
  const params = new URLSearchParams();
  for (const login of channelLogins()) params.append("user_login", login);
  const response = await fetch(`https://api.twitch.tv/helix/streams?${params}`, {
    signal: twitchDeadline(signal),
    headers: { "Client-ID": env.TWITCH_CLIENT_ID ?? "", Authorization: `Bearer ${token}` },
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

}

export function ensureEventSubConnected(signal?: AbortSignal): void {
  if (twitchShutdown.signal.aborted || eventSubSocket || !eventSubEnabled() || !env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET || channelLogins().length === 0) return;

  console.log("[eventsub] connecting websocket");
  eventSubSocket = new WebSocket("wss://eventsub.wss.twitch.tv/ws");
  eventSubSocket.on("message", (raw) => {
    if (twitchShutdown.signal.aborted) return;
    void trackTwitchEvent(handleEventSubMessage(String(raw), signal).catch((error) => {
      if (!signal?.aborted) logServiceAlert({
        code: "twitch_eventsub_message_failed",
        title: "Ошибка обработки Twitch EventSub",
        component: "twitch-eventsub",
        error,
      });
    }));
  });
  eventSubSocket.on("close", () => {
    console.log("[eventsub] websocket closed");
    eventSubSocket = null;
  });
  eventSubSocket.on("error", (error) => {
    if (twitchShutdown.signal.aborted) return;
    logServiceAlert({
      code: "twitch_eventsub_socket_failed",
      title: "Соединение Twitch EventSub прервано",
      component: "twitch-eventsub",
      error,
    });
    eventSubSocket?.close();
  });
}

export async function ensureChatConnected(): Promise<void> {
  const { signal } = twitchShutdown;
  if (signal.aborted) return;
  // Native WebSocket can keep waiting for an IRC handshake or a close
  // acknowledgement. A stopped client can no longer accept any events.
  let onStop!: () => void;
  const stopped = new Promise<void>(resolve => { onStop = resolve; });
  signal.addEventListener("abort", onStop, { once: true });
  try {
    await Promise.race([maintainChatConnection(), stopped]);
  } finally {
    signal.removeEventListener("abort", onStop);
  }
}

async function maintainChatConnection(): Promise<void> {
  const channels = channelLogins();
  if (chatClient) {
    if (Date.now() < nextChatMembershipCheckAt) return;
    nextChatMembershipCheckAt = Date.now() + chatMembershipCheckIntervalMs;
    await rejoinMissingChatChannel(chatClient, channels);
    return;
  }
  if (chatConnecting || channels.length === 0) return;

  chatConnecting = true;
  console.log(`[chat] connecting channels=${channels.join(",")}`);
  const useAuthenticatedChat = Boolean(env.TWITCH_BOT_USERNAME && env.TWITCH_BOT_OAUTH);
  const client = createChatClient(channels, useAuthenticatedChat);

  try {
    await client.connect();
    if (twitchShutdown.signal.aborted) return;
    console.log(`[chat] connected mode=${useAuthenticatedChat ? "authenticated" : "anonymous"}`);
    nextChatMembershipCheckAt = Date.now() + channels.length * chatInitialJoinIntervalMs + chatMembershipCheckIntervalMs;
  } catch (error) {
    if (twitchShutdown.signal.aborted) return;
    const message = errorMessage(error);
    if (useAuthenticatedChat && /login authentication failed/i.test(message)) {
      console.warn("[chat] authenticated connect failed; retrying anonymous");
      await disconnectChatClient(client);
      if (twitchShutdown.signal.aborted) return;
      await createChatClient(channels, false).connect();
      if (twitchShutdown.signal.aborted) return;
      console.log("[chat] connected mode=anonymous");
      nextChatMembershipCheckAt = Date.now() + channels.length * chatInitialJoinIntervalMs + chatMembershipCheckIntervalMs;
      return;
    }

    chatClient = null;
    throw error;
  } finally {
    chatConnecting = false;
  }
}

async function rejoinMissingChatChannel(client: InstanceType<typeof tmi.Client>, channels: string[]): Promise<void> {
  const joined = new Set(client.getChannels().map((channel) => channel.replace(/^#/, "").toLowerCase()));
  const missing = channels.find((channel) => !joined.has(channel));
  if (!missing) return;

  try {
    await client.join(missing);
    console.log(`[chat] restored channel=${missing}`);
  } catch (error) {
    logServiceAlert({
      code: "twitch_chat_join_failed",
      title: "Не удалось подключиться к Twitch-чату",
      component: "twitch-chat",
      context: `channel=${missing}`,
      severity: "action",
      reason: "Worker не получает сообщения этого канала и повторит подключение автоматически",
      errorCode: "chat_join_failed",
      error,
    });
  }
}

function createChatClient(channels: string[], authenticated: boolean): InstanceType<typeof tmi.Client> {
  const client = new WorkerChatClient({
    ...(authenticated ? { identity: { username: env.TWITCH_BOT_USERNAME!, password: env.TWITCH_BOT_OAUTH! } } : {}),
    channels: [...channels],
    connection: { reconnect: true, secure: true },
  });
  chatClient = client;
  attachChatHandlers(client);
  return client;
}

// tmi may still have a reconnect timer for an old client after a replacement.
class WorkerChatClient extends tmi.Client {
  override connect(): Promise<[string, number]> {
    if (chatClient !== this || twitchShutdown.signal.aborted) return Promise.reject(new Error("IRC client retired"));
    return super.connect();
  }
}

function trackTwitchEvent(event: Promise<void>): Promise<void> {
  twitchEvents.add(event);
  return event.finally(() => twitchEvents.delete(event));
}

export async function stopTwitchConnections(): Promise<void> {
  twitchShutdown.abort();
  eventSubSocket?.terminate();
  const client = chatClient;
  chatClient = null;
  if (client) void disconnectChatClient(client);
  await Promise.allSettled(twitchEvents);
}

function attachChatHandlers(client: InstanceType<typeof tmi.Client>): void {
  client.on("message", (channel, tags, message, self) => {
    if (twitchShutdown.signal.aborted || client !== chatClient) return;
    return trackTwitchEvent(onMessage(channel, tags, message, self));
  });
  async function onMessage(channel: string, tags: Record<string, string | undefined>, message: string, self: boolean) {
    const login = channel.replace(/^#/, "").toLowerCase();
    const authorName = tags["display-name"] ?? tags.username ?? "unknown";
    const urls = extractUrls(message);
    const mediaUrls = urls.filter(isSupportedMediaCandidateUrl);
    if (urls.length > 0) {
      const preview = message.replace(/\s+/g, " ").slice(0, 200);
      console.log(`[chat] message channel=${login} author=${authorName} self=${self} urls=${urls.length} media=${mediaUrls.length} text=${JSON.stringify(preview)}`);
    }

    const input: ChatMessageInput = {
      streamerLogin: login,
      twitchMessageId: tags.id,
      authorTwitchId: tags["user-id"],
      authorLogin: tags.username,
      authorName,
      messageText: message,
      postedAt: new Date(),
    };
    try {
      const context = await recordChatMessage(input).catch((error) => {
        logServiceAlert({
          code: "chat_record_failed",
          title: "Не удалось сохранить сообщение чата",
          component: "twitch-chat",
          context: `channel=${login}`,
          error,
        });
        return undefined;
      });
      await ingestChatMessage(input, context);
    } catch (error) {
      logServiceAlert({
        code: "chat_ingest_failed",
        title: "Не удалось обработать сообщение чата",
        component: "twitch-chat",
        context: `channel=${login}`,
        error,
      });
    }
  }
  const chatEvents = client as unknown as {
    on(event: "disconnected", handler: (reason: string) => void): void;
    on(event: "reconnect", handler: () => void): void;
    on(event: "notice", handler: (channel: string, msgid: string, message: string) => void): void;
  };
  chatEvents.on("disconnected", (reason: string) => {
    console.warn(`[chat] disconnected reason=${reason}`);
  });
  chatEvents.on("reconnect", () => console.warn("[chat] reconnecting"));
  chatEvents.on("notice", (channel: string, msgid: string, message: string) => {
    if (msgid === "msg_channel_suspended" || msgid === "msg_room_not_found") {
      logServiceAlert({
        code: "twitch_channel_unavailable",
        title: "Twitch-канал недоступен",
        component: "twitch-chat",
        context: `channel=${channel.replace(/^#/, "")}`,
        severity: "action",
        reason: "Канал удалён, переименован или заблокирован Twitch",
        errorCode: msgid,
        error: new Error(message),
      });
      return;
    }
    console.warn(`[chat] notice channel=${channel} msgid=${msgid} message=${message}`);
  });
}

async function disconnectChatClient(client: InstanceType<typeof tmi.Client>): Promise<void> {
  const transport = client as typeof client & { ws?: { terminate?: () => void }; reconnect: boolean; disconnect(): Promise<unknown> };
  transport.reconnect = false;
  const socket = transport.ws;
  const closed = transport.disconnect().catch(() => undefined);
  if (twitchShutdown.signal.aborted) socket?.terminate?.();
  await closed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function handleEventSubMessage(raw: string, signal?: AbortSignal): Promise<void> {
  const message = JSON.parse(raw) as EventSubMessage;

  if (message.metadata.message_type === "session_welcome" && message.payload.session?.id) {
    console.log("[eventsub] session welcome");
    await subscribeEventSub(message.payload.session.id, signal);
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
          twitchStreamId: event.id ?? active.twitchStreamId,
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

async function subscribeEventSub(sessionId: string, signal?: AbortSignal): Promise<void> {
  const token = env.TWITCH_EVENTSUB_USER_TOKEN || (await getAppToken(signal));
  const streamers = await prisma.streamer.findMany({ where: { enabled: true, login: { in: channelLogins() } } });
  const specs = streamers.flatMap((streamer) => eventSubSubscriptionSpecs(streamer.twitchUserId));
  const results = await Promise.all(
    specs.map(async (spec) => {
      const response = await fetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
        signal: twitchDeadline(signal),
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
    logServiceAlert({
      code: "twitch_eventsub_subscribe_failed",
      title: "Не удалось подписаться на Twitch EventSub",
      component: "twitch-eventsub",
      context: `type=${result.spec.type}`,
      error: new Error(`Twitch EventSub subscribe failed with ${result.response.status}`),
      details: { status: result.response.status, body: result.body.slice(0, 500) },
    });
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

function chatMessageContextSql(input: ChatMessageInput) {
  const cutoff = new Date(input.postedAt.getTime() - offlineGraceMs);
  return Prisma.sql`
    SELECT streamer.id AS "streamerId", streamer."youtubeDisabledUntil",
           session.id AS "streamSessionId", session."startedAt"
    FROM streamers AS streamer
    LEFT JOIN stream_sessions AS session
      ON session."streamerId" = streamer.id AND session.status = 'live'
      AND session."startedAt" <= (${input.postedAt}::timestamptz AT TIME ZONE 'UTC')
      AND (session."endedAt" IS NULL OR session."endedAt" > (${cutoff}::timestamptz AT TIME ZONE 'UTC'))
    WHERE streamer.login = ${input.streamerLogin}
    ORDER BY session."startedAt" DESC
    LIMIT 1
  `;
}

export async function recordChatMessage(input: ChatMessageInput): Promise<ChatMessageContext | null | undefined> {
  if (!input.twitchMessageId) return;
  if (isIgnoredChatAuthor(input.authorName) || isIgnoredChatCommand(input.messageText)) return;

  const [context] = await prisma.$queryRaw<ChatMessageContext[]>`
    WITH context AS (${chatMessageContextSql(input)}), buffered AS (
      INSERT INTO twitch_chat_messages AS message
        (id, "streamerId", "streamSessionId", "twitchMessageId", "authorTwitchId", "authorLogin",
         "authorName", "messageText", "postedAt", "createdAt")
      SELECT gen_random_uuid()::text, "streamerId", "streamSessionId", ${input.twitchMessageId},
             ${input.authorTwitchId ?? null}, ${input.authorLogin ?? null}, ${input.authorName}, ${input.messageText},
             ${input.postedAt}::timestamptz AT TIME ZONE 'UTC', CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
      FROM context WHERE "streamSessionId" IS NOT NULL
      ON CONFLICT ("streamerId", "twitchMessageId") DO UPDATE SET
        "streamSessionId" = EXCLUDED."streamSessionId", "postedAt" = EXCLUDED."postedAt",
        "authorTwitchId" = COALESCE(EXCLUDED."authorTwitchId", message."authorTwitchId"),
        "authorLogin" = COALESCE(EXCLUDED."authorLogin", message."authorLogin"),
        "authorName" = EXCLUDED."authorName", "messageText" = EXCLUDED."messageText"
    )
    SELECT * FROM context
  `;
  return context ?? null;
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

export async function ingestChatMessage(input: ChatMessageInput, bufferedContext?: ChatMessageContext | null): Promise<"retry" | void> {
  if (isIgnoredChatAuthor(input.authorName)) {
    console.log(`[chat] ignored author channel=${input.streamerLogin} author=${input.authorName}`);
    return;
  }

  if (isIgnoredChatCommand(input.messageText)) {
    console.log(`[chat] ignored command channel=${input.streamerLogin} author=${input.authorName}`);
    return;
  }

  let skipTelegramPublic = input.skipTelegramPublic === true || hasSkipTelegramPublicTag(input.messageText);
  const urls = input.wtvCandidateUrls ?? extractUrls(skipTelegramPublic ? stripSkipTelegramPublicTag(input.messageText) : input.messageText).filter(isSupportedMediaCandidateUrl);
  if (!urls.length && !input.wtvCandidateUrls) return;

  // Only a skipped or failed buffer operation needs a fresh lookup.
  const context = bufferedContext === undefined
    ? (await prisma.$queryRaw<ChatMessageContext[]>(chatMessageContextSql(input)))[0]
    : bufferedContext;
  if (!context) {
    console.warn(`[chat] ignored unknown-streamer login=${input.streamerLogin}`);
    return;
  }

  if (!context.streamSessionId || !context.startedAt) {
    console.log(`[chat] ignored offline media channel=${input.streamerLogin}`);
    return;
  }

  const wtvMessageId = input.twitchMessageId?.startsWith("wtv:") ? input.twitchMessageId : undefined;
  let candidates = [...new Set(urls)];
  if (input.wtvSessionId && input.wtvSessionId !== context.streamSessionId) return;
  let pending = false;
  if (wtvMessageId) {
    const prepared = await prepareWtvMessage(context.streamSessionId, wtvMessageId, { ...input, skipTelegramPublic }, candidates);
    if (!prepared) return;
    input = { ...input, ...prepared.context };
    skipTelegramPublic = prepared.context.skipTelegramPublic === true;
    candidates = prepared.candidates;
    pending = prepared.pending;
  }

  let retry = false;
  for (const [i, candidateUrl] of candidates.entries()) {
    if (input.signal?.aborted) return "retry";
    let rawUrl: string | null;
    try {
      if (wtvMessageId && isShortLinkUrl(candidateUrl)) {
        rawUrl = await resolveWtvRedirect(context.streamSessionId, wtvMessageId, candidateUrl, input.signal);
      } else {
        rawUrl = await resolveSupportedMediaUrl(candidateUrl, input.signal);
      }
    } catch (error) {
      if (input.signal?.aborted) {
        if (wtvMessageId && pending && candidates.length > 1) {
          // Give unattempted siblings the next poll before retrying the stalled link.
          await prisma.wtvPendingMessage.updateMany({ where: { sessionId: context.streamSessionId, messageId: wtvMessageId, sourceUrls: { equals: candidates }, skipTelegramPublic },
            data: { sourceUrls: [...candidates.slice(i + 1), ...candidates.slice(0, i + 1)] } });
        }
        return "retry";
      }
      if (!(error instanceof TemporaryShortLinkError)) throw error;
      retry = true;
      continue;
    }
    if (!rawUrl) continue;
    if (context.youtubeDisabledUntil && context.youtubeDisabledUntil > new Date() && isYouTubeUrl(rawUrl)) {
      console.log(`[chat] ignored youtube channel=${input.streamerLogin} until=${context.youtubeDisabledUntil.toISOString()}`);
      continue;
    }
    const normalizedUrl = normalizeUrl(rawUrl);
    if (!normalizedUrl) continue;
    console.log(`[chat] media-url author=${input.authorName} url=${rawUrl} normalized=${normalizedUrl}`);

    const result = await saveChatMediaPost({
      streamSessionId: context.streamSessionId,
      twitchMessageId: input.twitchMessageId ? `${input.twitchMessageId}:${normalizedUrl}` : undefined,
      rawTwitchMessageId: input.twitchMessageId,
      deferPublicCopy: Boolean(wtvMessageId && env.TELEGRAM_PUBLIC_CHANNEL_ID && !privateStreamerLogins.has(input.streamerLogin.toLowerCase())),
      authorTwitchId: input.authorTwitchId,
      authorName: input.authorName,
      messageText: input.messageText,
      originalUrl: rawUrl,
      normalizedUrl,
      postedAt: input.postedAt,
      skipTelegramPublic,
    });
    if (result.outcome === "stored") {
      console.log(`[download] reused asset=${result.asset.id} chatPost=${result.postId}`);
      if (wtvMessageId) continue; // The post transaction queued its public copy.
      await publishStoredTelegramMedia(result.asset, {
        streamerLogin: input.streamerLogin,
        streamStartedAt: context.startedAt,
        authorName: input.authorName,
        messageText: input.messageText,
        skipTelegramPublic,
      });
    } else if (result.outcome === "queued" || result.outcome === "active") {
      console.log(`[download] ${result.outcome} chatPost=${result.postId} asset=${result.assetId}`);
    }
  }
  if (retry) return "retry";
  if (wtvMessageId && pending) {
    await prisma.wtvPendingMessage.deleteMany({ where: { sessionId: context.streamSessionId, messageId: wtvMessageId, sourceUrls: { equals: candidates }, skipTelegramPublic } });
  }
}

function isYouTubeUrl(rawUrl: string): boolean {
  const hostname = toUrl(rawUrl)?.hostname.toLowerCase();
  return hostname === "youtu.be" || hostname === "youtube.com" || hostname?.endsWith(".youtube.com") === true;
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

async function syncConfiguredStreamers(token: string, signal?: AbortSignal): Promise<void> {
  const params = new URLSearchParams();
  const logins = channelLogins();
  for (const login of logins) params.append("login", login);
  const response = await fetch(`https://api.twitch.tv/helix/users?${params}`, {
    signal: twitchDeadline(signal),
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
  return prisma.streamSession.findFirst({
    where: {
      streamerId,
      status: "live",
      OR: [{ endedAt: null }, { endedAt: { gte: new Date(seenAt.getTime() - offlineGraceMs) } }],
    },
    orderBy: { startedAt: "desc" },
    select: { id: true, startedAt: true },
  });
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
        twitchStreamId: stream.id,
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

async function finalizeExpiredGraceSessions(logins: string[]): Promise<void> {
  const cutoff = new Date(Date.now() - offlineGraceMs);
  const update = await prisma.streamSession.updateMany({
    where: { streamer: { login: { in: logins }, NOT: { twitchUserId: { startsWith: "wtv:" } } }, status: "live", endedAt: { lt: cutoff } },
    data: { status: "ended" },
  });
  if (update.count > 0) console.log(`[twitch] finalized grace sessions=${update.count}`);
}

async function getAppToken(signal?: AbortSignal): Promise<string> {
  if (appToken && appToken.expiresAt > Date.now() + 60_000) return appToken.value;
  const response = await fetch("https://id.twitch.tv/oauth2/token", {
    signal: twitchDeadline(signal),
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
