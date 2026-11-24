import { once } from "node:events";
import { createServer } from "node:http";
import { Bot } from "grammy";
import { expect, it, vi } from "vitest";
import { createPublicPolling } from "./public-polling.js";
import { publicTelegramFetch } from "./rate-limit.js";

vi.mock("./public-inbox.js", () => ({
  PublicInboxError: class extends Error {},
  publicInbox: () => ({ recover: async () => [], prune: async () => {}, accept: async () => [] }),
}));

it("releases an unfinished 503 response and aborts a real long poll on stop", async () => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP port");
  const bot = new Bot("2:fixture", { client: { apiRoot: `http://127.0.0.1:${address.port}`, fetch: publicTelegramFetch } });
  const connections: number[] = [];
  let gatewayClosed!: () => void;
  const gatewayReleased = new Promise<void>(resolve => { gatewayClosed = resolve; });
  let received!: () => void;
  const pollingStarted = new Promise<void>(resolve => { received = resolve; });
  let closed!: () => void;
  const pollClosed = new Promise<void>(resolve => { closed = resolve; });
  server.on("request", (req, res) => {
    connections.push(req.socket.remotePort!);
    if (connections.length === 1) {
      res.on("close", gatewayClosed);
      res.writeHead(503).write("unavailable");
    } else if (req.url?.endsWith("/getUpdates")) {
      res.on("close", closed);
      received();
    } else {
      const result = req.url?.endsWith("/getMe") ? { id: 2, is_bot: true, first_name: "Test", username: "archive_bot" } : true;
      res.end(JSON.stringify({ ok: true, result }));
    }
  });
  const polling = createPublicPolling(bot);
  const running = polling.start();
  try {
    await pollingStarted;
    expect(connections).toHaveLength(4);
    await gatewayReleased;
    await polling.stop();
    await running;
    await pollClosed;
  } finally {
    server.closeAllConnections();
    server.close();
    await polling.stop();
  }
});
