const ignoredChatAuthors = new Set(["nightbot", "streamelements"]);

export function isIgnoredChatCommand(messageText: string): boolean {
  const text = messageText.trim();
  return /^!sr(?:\s|$)/i.test(text) || /(?:^|\s)catAsk(?=\s|$)/i.test(text) || /^(?:@\S+\s+)*Added to queue:/i.test(text);
}

export function isIgnoredChatAuthor(authorName: string): boolean {
  return ignoredChatAuthors.has(authorName.trim().toLowerCase());
}

export { hasSkipTelegramPublicTag, stripSkipTelegramPublicTag } from "@dawgostan/core";
