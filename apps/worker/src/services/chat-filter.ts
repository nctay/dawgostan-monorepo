const ignoredChatAuthors = new Set(["nightbot", "streamelements"]);

export function isIgnoredChatCommand(messageText: string): boolean {
  const text = messageText.trim();
  return /^!sr(?:\s|$)/i.test(text) || /(?:^|\s)catAsk(?=\s|$)/i.test(text) || /^(?:@\S+\s+)*Added to queue:/i.test(text);
}

export function isIgnoredChatAuthor(authorName: string): boolean {
  return ignoredChatAuthors.has(authorName.trim().toLowerCase());
}

export function hasSkipTelegramPublicTag(messageText: string): boolean {
  return /!skip_tg(?=https?:\/\/|\s|$)/i.test(messageText);
}

export function stripSkipTelegramPublicTag(messageText: string): string {
  return messageText.replace(/!skip_tg(?=https?:\/\/|\s|$)/gi, " ").replace(/\s+/g, " ").trim();
}
