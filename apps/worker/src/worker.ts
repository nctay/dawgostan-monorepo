import { runWorker } from "./worker-loop.js";

const shutdown = new AbortController();
process.on("SIGINT", () => shutdown.abort());
process.on("SIGTERM", () => shutdown.abort());
await runWorker(shutdown.signal);
// tmi 1.x keeps private reconnect timers even after its socket has closed.
await Promise.all([process.stdout, process.stderr].map(stream =>
  new Promise<void>(resolve => stream.write("", () => resolve()))));
process.exit();
