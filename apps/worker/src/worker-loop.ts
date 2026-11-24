import { cleanupExpiredChatMessages, ensureChatConnected, ensureEventSubConnected, pollTwitchStreams, stopTwitchConnections } from "./services/twitch.js";
import { pollWtvStreams } from "./services/wtv.js";
import { processDownloadQueue, recoverInterruptedDownloadJobs, waitForDownloadQueue } from "./services/downloader.js";
import { prisma } from "./prisma.js";
import { runPolls } from "./polling.js";
import { processPublicReposts } from "./services/public-reposts.js";

const tasks = [
  { run: processPublicReposts, code: "public_repost_failed", title: "Не удалось обработать повторную публикацию", component: "telegram" },
  { run: processDownloadQueue, code: "download_queue_failed", title: "Очередь загрузок остановилась", component: "downloader" },
  { run: ensureEventSubConnected, code: "twitch_eventsub_socket_failed", title: "Соединение Twitch EventSub прервано", component: "twitch-eventsub" },
  { run: ensureChatConnected, code: "twitch_chat_connect_failed", title: "Twitch-чат недоступен", component: "twitch-chat" },
  { run: pollTwitchStreams, code: "twitch_poll_failed", title: "Не удалось проверить Twitch-стримы", component: "twitch" },
  { run: () => cleanupExpiredChatMessages(), code: "chat_cleanup_failed", title: "Не удалось очистить старые сообщения", component: "database" },
];

export async function runWorker(signal: AbortSignal): Promise<void> {
  await recoverInterruptedDownloadJobs();
  let stopped = Promise.resolve();
  const stop = () => { stopped = stopTwitchConnections(); };
  if (signal.aborted) stop();
  else signal.addEventListener("abort", stop, { once: true });
  await Promise.all([runPolls(tasks, tasks.length, signal), pollWtvStreams(signal)]);
  await stopped;
  await waitForDownloadQueue();
  await prisma.$disconnect();
}
