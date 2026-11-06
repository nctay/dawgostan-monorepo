import { z } from "zod";

export const env = z
  .object({
    DATABASE_URL: z.string().min(1),
    TELEGRAM_BOT_TOKEN: z.string().min(1),
    TELEGRAM_STORAGE_CHAT_ID: z.string().min(1),
    TELEGRAM_ALLOWED_USER_IDS: z.string().min(1),
    TELEGRAM_PUBLIC_BOT_TOKEN: z.string().optional(),
    TELEGRAM_CONVERTER_BOT_TOKEN: z.string().optional(),
    TELEGRAM_CONVERTER_ALLOWED_USERNAMES: z.string().default(""),
    TELEGRAM_PRIVATE_STREAMER_LOGINS: z.string().default(""),
  })
  .superRefine((value, ctx) => {
    if (!value.TELEGRAM_CONVERTER_BOT_TOKEN) return;
    const names = value.TELEGRAM_CONVERTER_ALLOWED_USERNAMES.split(",").map((name) => name.trim().replace(/^@/, ""));
    if (!names.length || names.some((name) => !/^[a-zA-Z0-9_]{1,32}$/.test(name))) {
      ctx.addIssue({ code: "custom", path: ["TELEGRAM_CONVERTER_ALLOWED_USERNAMES"], message: "Set the allowed Telegram usernames for the converter" });
    }
    if ([value.TELEGRAM_BOT_TOKEN, value.TELEGRAM_PUBLIC_BOT_TOKEN].includes(value.TELEGRAM_CONVERTER_BOT_TOKEN)) {
      ctx.addIssue({ code: "custom", path: ["TELEGRAM_CONVERTER_BOT_TOKEN"], message: "Use a separate bot token for the converter" });
    }
  })
  .parse(process.env);

export const allowedUserIds = new Set(
  env.TELEGRAM_ALLOWED_USER_IDS.split(",")
    .map((id) => Number(id.trim()))
    .filter(Number.isSafeInteger),
);

export const privateStreamerLogins = new Set(
  env.TELEGRAM_PRIVATE_STREAMER_LOGINS.split(",")
    .map((login) => login.trim().toLowerCase())
    .filter(Boolean),
);
