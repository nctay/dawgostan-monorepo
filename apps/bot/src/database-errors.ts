import { setTimeout as delay } from "node:timers/promises";
import { logBotAlert } from "./alert-log.js";
import { Prisma } from "@prisma/client";

const transientCodes = new Set(["P1001", "P1002", "P1008", "P1017", "P2024", "P2034", "P2037"]);

export function isTransientDatabaseError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientInitializationError) {
    if (error.errorCode) return transientCodes.has(error.errorCode);
    // Prisma 6 omits errorCode when the first query opens the pool lazily.
    return /^Can't reach database server at /m.test(error.message)
      || /^Timed out fetching a new connection from the connection pool/m.test(error.message)
      || /^Too many database connections opened:/m.test(error.message);
  }
  return error instanceof Prisma.PrismaClientKnownRequestError && transientCodes.has(error.code);
}

export async function retryInbox<T>(operation: () => Promise<T>, signal: AbortSignal) {
  // Allow a handler already draining at shutdown to finish its receipt once.
  for (let wait = 100; ; wait = Math.min(30_000, wait * 2)) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientDatabaseError(error)) throw error;
      signal.throwIfAborted();
      logBotAlert({ scope: "public-inbox", error: new Error("Database temporarily unavailable") });
      await delay(wait, undefined, { signal });
      signal.throwIfAborted();
    }
  }
}
