import type { Update } from "grammy/types";

export const mediaPage = /^pub:(stream|after):([^:]+):(\d+)$/;
export const ackOnly = "publicPageAckOnly";

export function publicPageKey(update: Update) {
  const callback = update.callback_query;
  if (!callback?.data || !mediaPage.test(callback.data)) return null;
  return `${callback.message?.chat.id ?? ""}:${callback.from.id}:${callback.data}`;
}
