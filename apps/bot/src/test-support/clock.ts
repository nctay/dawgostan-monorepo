// Vitest 3's fake clock advances global timers but leaves node:timers/promises on wall time.
export function setTimeout<T>(ms: number, value: T, { signal }: { signal?: AbortSignal } = {}) {
  return new Promise<T>((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve(value);
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
