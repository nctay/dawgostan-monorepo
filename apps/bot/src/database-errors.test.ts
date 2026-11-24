import { Prisma, PrismaClient } from "@prisma/client";
import { expect, it } from "vitest";
import { isTransientDatabaseError } from "./database-errors.js";

it.each(["P2024", "P2037"])("retries pool exhaustion (%s)", code => {
  expect(isTransientDatabaseError(new Prisma.PrismaClientKnownRequestError("pool full", { code, clientVersion: "6" }))).toBe(true);
});

it("recognizes exhausted PostgreSQL connections on a lazy initialization", () => {
  const error = new Prisma.PrismaClientInitializationError('Too many database connections opened: FATAL: too many connections for role "bot"', "6");
  expect(isTransientDatabaseError(error)).toBe(true);
});

it("propagates a real lazy Prisma initialization error for an invalid database URL", async () => {
  const db = new PrismaClient({ datasourceUrl: "invalid://localhost/archive" });
  try {
    const error = await db.publicBotUpdate.findMany().then(() => undefined, error => error);
    expect(error).toBeInstanceOf(Prisma.PrismaClientInitializationError);
    expect(isTransientDatabaseError(error)).toBe(false);
  } finally {
    await db.$disconnect();
  }
});

it.skipIf(!process.env.PUBLIC_BOT_TEST_DATABASE_URL)("retries a query when a saturated Prisma pool releases its only connection", async () => {
  const url = new URL(process.env.PUBLIC_BOT_TEST_DATABASE_URL!);
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("pool_timeout", "1");
  const db = new PrismaClient({ datasourceUrl: url.toString() });
  const { retryInbox } = await import("./database-errors.js");
  let release!: () => void;
  const busy = new Promise<void>(resolve => { release = resolve; });
  let ready!: () => void;
  const borrowed = new Promise<void>(resolve => { ready = resolve; });
  const transaction = db.$transaction(async () => { ready(); await busy; });
  const errors: string[] = [];
  try {
    await borrowed;
    const count = await retryInbox(async () => {
      try {
        return await db.publicBotUpdate.count();
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError) errors.push(error.code);
        release();
        throw error;
      }
    }, AbortSignal.timeout(4_000));
    expect(count).toBeGreaterThanOrEqual(0);
    expect(errors).toEqual(["P2024"]);
  } finally {
    release();
    await transaction;
    await db.$disconnect();
  }
});
