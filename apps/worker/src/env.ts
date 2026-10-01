import { z } from "zod";

export const env = z
  .object({
    DATABASE_URL: z.string().min(1),
    TWITCH_CLIENT_ID: z.string().optional(),
    TWITCH_CLIENT_SECRET: z.string().optional(),
    TWITCH_EVENTSUB_USER_TOKEN: z.string().optional(),
    TWITCH_EVENTSUB_USER_ID: z.string().optional(),
    TWITCH_BOT_USERNAME: z.string().optional(),
    TWITCH_BOT_OAUTH: z.string().optional(),
    TWITCH_CHANNELS: z.string().default(""),
    WTV_CHANNELS: z.string().default(""),
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    TELEGRAM_STORAGE_CHAT_ID: z.string().optional(),
    TELEGRAM_PUBLIC_CHANNEL_ID: z.string().optional(),
    TELEGRAM_DELETED_CHANNEL_ID: z.string().optional(),
    TELEGRAM_PRIVATE_STREAMER_LOGINS: z.string().default(""),
    TWITCH_CHAT_MESSAGE_RETENTION_MINUTES: z.coerce.number().default(120),
    MAX_IMAGE_BYTES: z.coerce.number().default(30 * 1024 * 1024),
    MAX_VIDEO_BYTES: z.coerce.number().default(100 * 1024 * 1024),
    MAX_DAILY_DOWNLOAD_BYTES: z.coerce.number().default(10 * 1024 * 1024 * 1024),
    MAX_PARALLEL_DOWNLOADS: z.coerce.number().default(2),
    ALLOW_PRIVATE_MEDIA_HOSTS: z.coerce.boolean().default(false),
    ENABLE_PLATFORM_DOWNLOADS: z.coerce.boolean().default(false),
    MAX_PLATFORM_VIDEO_SECONDS: z.coerce.number().default(300),
    PLATFORM_DOWNLOAD_TIMEOUT_MS: z.coerce.number().default(600_000),
    NSFW_MAX_FRAMES: z.coerce.number().int().min(1).max(20).default(8),
    NSFW_ENSEMBLE_CLASSIFIER_URL: z.string().url().optional(),
    NSFW_ENSEMBLE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.8),
  })
  .parse(process.env);

export const twitchChannels = env.TWITCH_CHANNELS.split(",")
  .map((channel) => channel.trim().toLowerCase().replace(/^#/, ""))
  .filter(Boolean);

export const wtvChannels = env.WTV_CHANNELS.split(",")
  .map((channel) => parseWtvChannel(channel))
  .filter(Boolean);

export const privateStreamerLogins = new Set(
  env.TELEGRAM_PRIVATE_STREAMER_LOGINS.split(",")
    .map((login) => login.trim().toLowerCase())
    .filter(Boolean),
);

function parseWtvChannel(channel: string): string {
  const trimmed = channel.trim();
  if (!trimmed) return "";

  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() === "w.tv") {
      return url.pathname.split("/").filter(Boolean)[0]?.toLowerCase() ?? "";
    }
  } catch {
    // Not a URL; treat it as a nickname/id below.
  }

  return trimmed
    .replace(/^@/, "")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
}
