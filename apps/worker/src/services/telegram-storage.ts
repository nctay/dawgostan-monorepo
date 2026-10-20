import path from "node:path";
import { spawn } from "node:child_process";
import { Bot, InputFile } from "grammy";
import type { Message } from "grammy/types";
import { env, privateStreamerLogins } from "../env.js";
import { prisma } from "../prisma.js";
import { logServiceAlert } from "../alert-log.js";
import { stripSkipTelegramPublicTag } from "./chat-filter.js";
import { SerialRateLimiter } from "./rate-limit.js";

let bot: Bot | null = null;
const storageSendLimiter = new SerialRateLimiter(1100);
const publicChannelSendLimiter = new SerialRateLimiter(1100);
const deletedChannelSendLimiter = new SerialRateLimiter(1100);
export const telegramMediaGroupMaxItems = 10;

type TelegramStoredAsset = {
  telegramChatId: string | null;
  telegramMessageId: number | null;
  telegramMessageIds?: number[];
  telegramFileId: string | null;
  telegramFileIds?: string[];
  telegramMediaTypes?: string[];
  telegramIsAnimation: boolean;
  publicHasSpoiler: boolean;
  mimeType: string | null;
  mediaType: string;
};

export type StoredMedia = {
  storageProvider: "telegram";
  telegramChatId: string;
  telegramMessageId: number;
  telegramMessageIds: number[];
  telegramFileId: string;
  telegramFileIds: string[];
  telegramMediaTypes: string[];
  telegramFileUniqueId: string;
};

export type StoreMediaMetadata = {
  originalUrl: string;
  normalizedUrl: string;
  sha256: string;
  streamerLogin: string;
  streamerDisplayName: string;
  streamStartedAt: Date;
  streamSessionId: string;
  assetId: string;
  authorName: string;
  messageText: string;
  skipTelegramPublic: boolean;
  telegramSendAsAnimation?: boolean;
};

export type PublicTelegramMediaMetadata = Pick<StoreMediaMetadata, "streamerLogin" | "streamStartedAt" | "authorName" | "messageText" | "skipTelegramPublic">;

function telegramBot(): Bot {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  bot ??= new Bot(env.TELEGRAM_BOT_TOKEN);
  return bot;
}

export async function storeTelegramMedia(filePath: string, mimeType: string, mediaType: "image" | "video", metadata: StoreMediaMetadata): Promise<StoredMedia> {
  if (!env.TELEGRAM_STORAGE_CHAT_ID) throw new Error("TELEGRAM_STORAGE_CHAT_ID is not configured");

  const caption = [
    `streamer=${metadata.streamerLogin}`,
    `session=${metadata.streamSessionId}`,
    `asset=${metadata.assetId}`,
    `sha256=${metadata.sha256}`,
    metadata.normalizedUrl,
  ].join("\n");

  const input = new InputFile(filePath, fileName(filePath, mimeType, mediaType));
  const videoMetadata = mediaType === "video" ? await readVideoMetadata(filePath) : {};
  const message = await storageSendLimiter.schedule<Message.PhotoMessage | Message.VideoMessage | Message.AnimationMessage>(async () => {
    if (isGif(mimeType) || metadata.telegramSendAsAnimation) {
      console.log(`[telegram] sendAnimation mime=${mimeType} file=${path.basename(filePath)}`);
      return telegramBot().api.sendAnimation(env.TELEGRAM_STORAGE_CHAT_ID!, input, { caption, ...videoMetadata });
    }
    if (mediaType === "image") {
      console.log(`[telegram] sendPhoto mime=${mimeType} file=${path.basename(filePath)}`);
      return telegramBot().api.sendPhoto(env.TELEGRAM_STORAGE_CHAT_ID!, input, { caption });
    }
    console.log(`[telegram] sendVideo mime=${mimeType} file=${path.basename(filePath)} width=${videoMetadata.width ?? "unknown"} height=${videoMetadata.height ?? "unknown"}`);
    return telegramBot().api.sendVideo(env.TELEGRAM_STORAGE_CHAT_ID!, input, { caption, supports_streaming: true, ...videoMetadata });
  });
  const file =
    "photo" in message
      ? message.photo.at(-1)
      : "video" in message
        ? message.video
        : "animation" in message
          ? message.animation
          : (message as unknown as Message.DocumentMessage).document;
  if (!file) throw new Error("Telegram did not return stored file metadata");

  return {
    storageProvider: "telegram",
    telegramChatId: String(message.chat.id),
    telegramMessageId: message.message_id,
    telegramMessageIds: [message.message_id],
    telegramFileId: file.file_id,
    telegramFileIds: [file.file_id],
    telegramMediaTypes: ["video" in message ? "video" : "photo" in message ? "photo" : "animation"],
    telegramFileUniqueId: file.file_unique_id,
  };
}

export async function storeTelegramMediaGroup(files: Array<{ filePath: string; mimeType: string; mediaType: "image" | "video" }>, metadata: StoreMediaMetadata): Promise<StoredMedia> {
  if (!env.TELEGRAM_STORAGE_CHAT_ID) throw new Error("TELEGRAM_STORAGE_CHAT_ID is not configured");
  if (files.length < 2) throw new Error("Telegram media group requires at least two files");

  const caption = [
    `streamer=${metadata.streamerLogin}`,
    `session=${metadata.streamSessionId}`,
    `asset=${metadata.assetId}`,
    `sha256=${metadata.sha256}`,
    metadata.normalizedUrl,
  ].join("\n");
  const messages: Array<Message.PhotoMessage | Message.VideoMessage> = [];
  for (let offset = 0; offset < files.length; offset += telegramMediaGroupMaxItems) {
    const batch = files.slice(offset, offset + telegramMediaGroupMaxItems);
    if (batch.length === 1) {
      const file = batch[0]!;
      const input = new InputFile(file.filePath, fileName(file.filePath, file.mimeType, file.mediaType));
      const videoMetadata = file.mediaType === "video" ? await readVideoMetadata(file.filePath) : {};
      messages.push(await storageSendLimiter.schedule<Message.PhotoMessage | Message.VideoMessage>(() => file.mediaType === "video"
        ? telegramBot().api.sendVideo(env.TELEGRAM_STORAGE_CHAT_ID!, input, { ...(offset === 0 ? { caption } : {}), supports_streaming: true, ...videoMetadata })
        : telegramBot().api.sendPhoto(env.TELEGRAM_STORAGE_CHAT_ID!, input, offset === 0 ? { caption } : {})));
    } else {
      const media = await Promise.all(batch.map(async (file, index) => {
        const input = new InputFile(file.filePath, fileName(file.filePath, file.mimeType, file.mediaType));
        const itemCaption = offset === 0 && index === 0 ? { caption } : {};
        return file.mediaType === "video"
          ? { type: "video" as const, media: input, supports_streaming: true, ...await readVideoMetadata(file.filePath), ...itemCaption }
          : { type: "photo" as const, media: input, ...itemCaption };
      }));
      const sent = await storageSendLimiter.schedule(() => telegramBot().api.sendMediaGroup(env.TELEGRAM_STORAGE_CHAT_ID!, media));
      messages.push(...sent as Array<Message.PhotoMessage | Message.VideoMessage>);
    }
  }

  const storedFiles = messages.map((message) => "photo" in message ? message.photo.at(-1) : message.video).filter((file): file is NonNullable<typeof file> => Boolean(file));
  if (messages.length !== files.length || storedFiles.length !== files.length) throw new Error("Telegram did not return all album file metadata");

  return {
    storageProvider: "telegram",
    telegramChatId: String(messages[0]!.chat.id),
    telegramMessageId: messages[0]!.message_id,
    telegramMessageIds: messages.map((message) => message.message_id),
    telegramFileId: storedFiles[0]!.file_id,
    telegramFileIds: storedFiles.map((file) => file.file_id),
    telegramMediaTypes: messages.map((message) => "video" in message ? "video" : "photo"),
    telegramFileUniqueId: storedFiles[0]!.file_unique_id,
  };
}

export async function publishStoredTelegramMedia(
  asset: TelegramStoredAsset & {
    id: string;
    visibility: "public" | "hidden";
    publicTelegramChatId: string | null;
    publicTelegramMessageId: number | null;
  },
  metadata: PublicTelegramMediaMetadata,
): Promise<void> {
  if (!asset.telegramChatId || !asset.telegramMessageId) return;
  if (asset.visibility === "hidden") {
    console.log(`[telegram] skip public channel hidden_asset=${asset.id}`);
    return;
  }
  if (metadata.skipTelegramPublic) {
    console.log(`[telegram] skip public channel user_tag streamer=${metadata.streamerLogin}`);
    return;
  }
  if (!env.TELEGRAM_PUBLIC_CHANNEL_ID) return;
  if (privateStreamerLogins.has(metadata.streamerLogin.toLowerCase())) {
    console.log(`[telegram] skip public channel private_streamer=${metadata.streamerLogin}`);
    return;
  }

  const claimedAt = new Date();
  const cutoff = new Date(claimedAt.getTime() - 48 * 60 * 60 * 1000);
  // shortcut: a crash after this claim can suppress an unsent post for 48 hours; add a lease if this occurs.
  const claim = await prisma.asset.updateMany({
    where: { id: asset.id, visibility: "public", OR: [{ publicTelegramPublishedAt: null }, { publicTelegramPublishedAt: { lte: cutoff } }] },
    data: { publicTelegramPublishedAt: claimedAt },
  });
  if (!claim.count) return;

  let copied: { telegramChatId: string; telegramMessageId: number };
  try {
    copied = await publishTelegramMedia(asset, metadata);
  } catch (error) {
    await prisma.asset.updateMany({
      where: { id: asset.id, publicTelegramPublishedAt: claimedAt },
      data: { publicTelegramPublishedAt: null },
    });
    throw error;
  }

  await prisma.asset.update({
    where: { id: asset.id },
    data: { publicTelegramChatId: copied.telegramChatId, publicTelegramMessageId: copied.telegramMessageId, publicTelegramPublishedAt: new Date() },
  });
}

function fileName(filePath: string, mimeType: string, mediaType: "image" | "video"): string {
  const ext = mimeType.split("/")[1]?.split("+")[0] || (mediaType === "image" ? "jpg" : "mp4");
  return `${path.basename(filePath)}.${ext}`;
}

function isGif(mimeType: string): boolean {
  return mimeType.split(";")[0]?.trim().toLowerCase() === "image/gif";
}

export async function readVideoMetadata(filePath: string, reportFailure = true): Promise<{ width?: number; height?: number; duration?: number }> {
  try {
    const output = await runFfprobe([
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height:format=duration",
      "-of",
      "json",
      filePath,
    ]);
    const parsed = JSON.parse(output) as { streams?: Array<{ width?: number; height?: number }>; format?: { duration?: string } };
    const stream = parsed.streams?.[0];
    const duration = Number(parsed.format?.duration);
    return {
      width: positiveInteger(stream?.width),
      height: positiveInteger(stream?.height),
      duration: Number.isFinite(duration) && duration > 0 ? Math.ceil(duration) : undefined,
    };
  } catch (error) {
    if (reportFailure) logServiceAlert({
      code: "ffprobe_failed",
      title: "Не удалось определить параметры видео",
      component: "media-processing",
      error,
    });
    return {};
  }
}

async function runFfprobe(args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("ffprobe", args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `ffprobe exit code ${code}`));
    });
  });
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

async function publishTelegramMedia(asset: TelegramStoredAsset, metadata: PublicTelegramMediaMetadata): Promise<{ telegramChatId: string; telegramMessageId: number }> {
  const copied = await publicChannelSendLimiter.schedule(() =>
    sendStoredTelegramMedia(env.TELEGRAM_PUBLIC_CHANNEL_ID!, asset, publicChannelCaption(metadata)),
  );
  return { telegramChatId: env.TELEGRAM_PUBLIC_CHANNEL_ID!, telegramMessageId: copied.message_id };
}

async function sendStoredTelegramMedia(chatId: string, asset: TelegramStoredAsset, caption: string): Promise<{ message_id: number }> {
  const albumFileIds = asset.telegramFileIds ?? [];
  if (albumFileIds.length > 1) {
    let firstMessageId: number | undefined;
    for (let offset = 0; offset < albumFileIds.length; offset += telegramMediaGroupMaxItems) {
      const batch = albumFileIds.slice(offset, offset + telegramMediaGroupMaxItems);
      const sent = batch.length === 1
        ? asset.telegramMediaTypes?.[offset] === "video"
          ? await telegramBot().api.sendVideo(chatId, batch[0]!, { caption, supports_streaming: true, ...(asset.publicHasSpoiler ? { has_spoiler: true } : {}) })
          : await telegramBot().api.sendPhoto(chatId, batch[0]!, { caption, ...(asset.publicHasSpoiler ? { has_spoiler: true } : {}) })
        : await telegramBot().api.sendMediaGroup(chatId, batch.map((fileId, index) => ({
            type: asset.telegramMediaTypes?.[offset + index] === "video" ? "video" as const : "photo" as const,
            media: fileId,
            ...(index === 0 ? { caption } : {}),
            ...(asset.publicHasSpoiler ? { has_spoiler: true } : {}),
          })));
      firstMessageId ??= (Array.isArray(sent) ? sent[0] : sent)?.message_id;
    }
    if (!firstMessageId) throw new Error("Telegram did not return a public album message");
    return { message_id: firstMessageId };
  }
  if (!asset.publicHasSpoiler) {
    return telegramBot().api.copyMessage(chatId, asset.telegramChatId!, asset.telegramMessageId!, { caption });
  }
  if (!asset.telegramFileId) throw new Error("Stored Telegram media has no file_id for spoiler resend");
  if (asset.telegramIsAnimation || isGif(asset.mimeType ?? "")) {
    return telegramBot().api.sendAnimation(chatId, asset.telegramFileId, { caption, has_spoiler: true });
  }
  if (asset.mediaType === "image") {
    return telegramBot().api.sendPhoto(chatId, asset.telegramFileId, { caption, has_spoiler: true });
  }
  return telegramBot().api.sendVideo(chatId, asset.telegramFileId, { caption, has_spoiler: true, supports_streaming: true });
}

export type DeletedChatMessageMetadata = {
  streamerLogin: string;
  streamStartedAt: Date;
  authorName: string;
  authorLogin?: string | null;
  messageText: string;
  twitchMessageId: string;
  linkedPosts: Array<{
    normalizedUrl: string;
    assetId: string | null;
    asset: (TelegramStoredAsset & {
      status: string;
      visibility: "public" | "hidden";
    }) | null;
  }>;
};

export async function publishDeletedChatMessage(metadata: DeletedChatMessageMetadata): Promise<{ telegramChatId: string; telegramMessageId: number } | null> {
  if (!env.TELEGRAM_DELETED_CHANNEL_ID) return null;
  if (metadata.linkedPosts.some((post) => post.asset?.visibility === "hidden")) {
    console.log(`[telegram] skip deleted channel hidden_asset message=${metadata.twitchMessageId}`);
    return null;
  }

  const copyablePosts = metadata.linkedPosts.filter(
    (post) => post.asset?.status === "stored" && post.asset.visibility === "public" && post.asset.telegramChatId && post.asset.telegramMessageId,
  );
  let firstMessageId: number | null = null;

  for (const post of copyablePosts) {
    const copied = await deletedChannelSendLimiter.schedule(() =>
      sendStoredTelegramMedia(env.TELEGRAM_DELETED_CHANNEL_ID!, post.asset!, deletedChannelCaption(metadata)),
    );
    firstMessageId ??= copied.message_id;
  }

  if (firstMessageId) {
    return { telegramChatId: env.TELEGRAM_DELETED_CHANNEL_ID, telegramMessageId: firstMessageId };
  }

  const sent = await deletedChannelSendLimiter.schedule(() =>
    telegramBot().api.sendMessage(env.TELEGRAM_DELETED_CHANNEL_ID!, deletedChannelCaption(metadata)),
  );
  return { telegramChatId: String(sent.chat.id), telegramMessageId: sent.message_id };
}

function publicChannelCaption(metadata: PublicTelegramMediaMetadata): string {
  const streamerTag = hashtag(`${metadata.streamerLogin}_stream`);
  const dateTag = hashtag(`date_${formatStreamDateTag(metadata.streamStartedAt)}`);
  const senderTag = hashtag(`user_${metadata.authorName}`);
  const text = stripSkipTelegramPublicTag(stripUrls(metadata.messageText));
  const prefix = `${streamerTag} ${dateTag} ${senderTag}`;
  return truncate(text ? `${prefix}: ${text}` : prefix, 1000);
}

function deletedChannelCaption(metadata: DeletedChatMessageMetadata): string {
  const streamerTag = hashtag(`${metadata.streamerLogin}_stream`);
  const dateTag = hashtag(`date_${formatStreamDateTag(metadata.streamStartedAt)}`);
  const senderTag = hashtag(`user_${metadata.authorLogin || metadata.authorName}`);
  const text = stripUrls(metadata.messageText).replace(/\s+/g, " ").trim();
  const prefix = `${streamerTag} ${dateTag} ${senderTag}`;
  return truncate(text ? `${prefix}: ${text}` : prefix, 1000);
}

function hashtag(value: string): string {
  return `#${value.replace(/[^\p{L}\p{N}_]/gu, "_")}`;
}

function formatStreamDateTag(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(date)
    .split("-");
  return parts.join("_");
}

function stripUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/gi, "").trim();
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}
