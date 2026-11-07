import { GrammyError } from "grammy";
import type { Api } from "grammy";
import type { InputMediaAnimation, InputMediaPhoto, InputMediaVideo } from "grammy/types";
import type { SerialRateLimiter } from "./rate-limit.js";

export type ConverterMedia = InputMediaAnimation | InputMediaPhoto | InputMediaVideo;

export async function sendConverterMedia(api: Api, chatId: string, input: ConverterMedia) {
  const { media, type, ...options } = input;
  if (type === "photo") return api.sendPhoto(chatId, media, options);
  if (type === "animation") return api.sendAnimation(chatId, media, options);
  return api.sendVideo(chatId, media, options);
}

export async function replaceChannelPost(
  api: Api, limiter: SerialRateLimiter, chatId: string, messageId: number, postedAt: Date, media: ConverterMedia,
  saveReplacement: (messageId: number) => Promise<unknown>,
): Promise<number> {
  try {
    await limiter.schedule(() => api.editMessageMedia(chatId, messageId, media));
    return messageId;
  } catch (error) {
    if (!(error instanceof GrammyError) || ![400, 403].includes(error.error_code)) throw error;
    if (/message is not modified/i.test(error.description)) return messageId;
    if (!/message can(?:not|'t) be edited|message edit time expired|message_edit_time_expired|not enough rights to edit|message_author_required/i.test(error.description)) throw error;
    if (Date.now() - postedAt.getTime() >= 48 * 60 * 60 * 1000) throw error;
    const { id } = await api.getMe();
    const member = await api.getChatMember(chatId, id);
    if (member.status !== "administrator" || !member.can_post_messages || !member.can_delete_messages) throw error;
  }
  const replacement = await limiter.schedule(() => sendConverterMedia(api, chatId, media));
  // Record the new post before deleting the original, so a failed delete never triggers another repost.
  await saveReplacement(replacement.message_id);
  await limiter.schedule(() => api.deleteMessage(chatId, messageId));
  return replacement.message_id;
}
