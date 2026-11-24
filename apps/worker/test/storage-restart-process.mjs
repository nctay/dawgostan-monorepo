import { Api } from "grammy";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// This fixture's 1x1 PNG needs no resizing. Stub the external size probe as in the parent test.
const probeDirectory = await mkdtemp(path.join(tmpdir(), "photo-probe-"));
await writeFile(path.join(probeDirectory, "magick"), '#!/bin/sh\n[ "$1" = "identify" ] || exit 1\nprintf "1 1"\n', { mode: 0o755 });
process.env.PATH = `${probeDirectory}:${process.env.PATH ?? ""}`;

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
