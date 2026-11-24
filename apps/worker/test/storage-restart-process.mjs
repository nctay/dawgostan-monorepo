import { Api } from "grammy";

globalThis.fetch = async () => new Response(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64",
), { headers: { "content-type": "image/png" } });
Api.prototype.sendPhoto = async () => ({
  chat: { id: -100 }, message_id: 435, date: 0,
  photo: [{ file_id: "file435", file_unique_id: "unique435", width: 1, height: 1 }],
});
const { processDownloadQueue, waitForDownloadQueue } = await import("../src/services/downloader.ts");
processDownloadQueue();
await waitForDownloadQueue();
