import { cleanupExpiredChatMessages, ensureChatConnected, ensureEventSubConnected, pollTwitchStreams } from "./services/twitch.js";
import { pollWtvStreams } from "./services/wtv.js";
import { processDownloadQueue } from "./services/downloader.js";
import { prisma } from "./prisma.js";
import { logServiceAlert } from "./alert-log.js";

let shuttingDown = false;
let downloadTask: Promise<void> | null = null;

async function tick(): Promise<void> {
  ensureEventSubConnected();
  void ensureChatConnected().catch((error) =>
    logServiceAlert({ code: "twitch_chat_connect_failed", title: "Twitch-чат недоступен", component: "twitch-chat", error }),
  );
  downloadTask ??= processDownloadQueue()
    .catch((error) =>
      logServiceAlert({
        code: "download_queue_failed",
        title: "Очередь загрузок остановилась",
        component: "downloader",
        severity: "critical",
        error,
      }),
    )
    .finally(() => {
      downloadTask = null;
    });
  const tasks = [
    { code: "twitch_poll_failed", title: "Не удалось проверить Twitch-стримы", component: "twitch", promise: pollTwitchStreams() },
    { code: "wtv_task_failed", title: "Не удалось проверить WTV-стримы", component: "wtv", promise: pollWtvStreams() },
    { code: "chat_cleanup_failed", title: "Не удалось очистить старые сообщения", component: "database", promise: cleanupExpiredChatMessages() },
  ];
  const results = await Promise.allSettled(tasks.map((task) => task.promise));
  for (const [index, result] of results.entries()) {
    if (result.status !== "rejected") continue;
    const task = tasks[index]!;
    logServiceAlert({ code: task.code, title: task.title, component: task.component, error: result.reason });
  }
}

async function loop(): Promise<void> {
  while (!shuttingDown) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

process.on("SIGINT", () => {
  shuttingDown = true;
});
process.on("SIGTERM", () => {
  shuttingDown = true;
});

await loop();
await downloadTask;
await prisma.$disconnect();
