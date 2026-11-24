import { logServiceAlert } from "./alert-log.js";

type PollTask = {
  run: (signal?: AbortSignal) => Promise<unknown> | void;
  code: string;
  component: string;
  title: string;
};

// Each slot takes the oldest eligible source. A source goes back to the end of
// the queue only after its poll finishes, so two slots cannot poll it together.
export async function runPolls(tasks: PollTask[], slots: number, signal?: AbortSignal): Promise<void> {
  const queue = tasks.map(task => ({ task, nextAt: 0 }));
  async function runSlot() {
    while (!signal?.aborted) {
      const entry = queue.shift();
      if (!entry) return;
      const delay = entry.nextAt - performance.now();
      if (delay > 0) {
        await new Promise<void>(resolve => {
          const done = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, delay);
          signal?.addEventListener("abort", done, { once: true });
        });
        if (signal?.aborted) return;
      }
      const { run, ...alert } = entry.task;
      try {
        await run(signal);
      } catch (error) {
        if (!signal?.aborted) logServiceAlert({ ...alert, error });
      }
      if (signal) {
        entry.nextAt = performance.now() + 5_000;
        queue.push(entry);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(slots, tasks.length) }, runSlot));
}
