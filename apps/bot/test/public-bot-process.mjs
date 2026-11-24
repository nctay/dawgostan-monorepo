// Exercise the deployed entry point with a local Telegram transport and transient database failures.
import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/prisma.ts";
import { Api, Bot, GrammyError, HttpError } from "grammy";

const currentUpdate = new AsyncLocalStorage();
const handle = Bot.prototype.handleUpdate;
Bot.prototype.handleUpdate = function (update, ...rest) {
  return currentUpdate.run(update.update_id, () => handle.call(this, update, ...rest));
};
Api.prototype.getMe = async function () {
  return { id: Number(this.token.split(":")[0]), is_bot: true, first_name: "Fixture", username: "fixture_bot" };
};
const recovering = process.env.FIXTURE_RECOVERING === "true";
const duplicate = process.env.FIXTURE_DUPLICATE === "true";
let copyStarted;
const copying = new Promise(resolve => { copyStarted = resolve; });
const failures = new Set();
function failOnce(name) {
  if (duplicate || !recovering || failures.has(name)) return false;
  failures.add(name);
  process.send({ type: name });
  return true;
}
function transportError(token, method) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  return new HttpError(`Request to ${url} failed`, new Error(`fetch failed: ${url}`));
}
const insertUpdates = prisma.$transaction.bind(prisma);
let insertAttempts = 0;
prisma.$transaction = async args => {
  if (recovering || duplicate || args.length < 3) return insertUpdates(args);
  if (++insertAttempts === 1) {
    process.send({ type: "inbox-unavailable" });
    throw new Prisma.PrismaClientKnownRequestError("could not connect", { code: "P1001", clientVersion: "test" });
  }
  const inserted = await insertUpdates(args);
  if (insertAttempts === 2) {
    process.send({ type: "inbox-commit-response-lost" });
    throw new Prisma.PrismaClientKnownRequestError("connection closed", { code: "P1017", clientVersion: "test" });
  }
  return inserted;
};
const finishUpdate = prisma.publicBotUpdate.updateMany.bind(prisma.publicBotUpdate);
prisma.publicBotUpdate.updateMany = args => currentUpdate.getStore() === undefined ? finishUpdate(args) : finishDuringUpdate(args);
async function finishDuringUpdate(args) {
  if (duplicate && !recovering && currentUpdate.getStore() === 2) {
    process.send({ type: "duplicate-finish-before-commit" });
    throw new Prisma.PrismaClientKnownRequestError("connection closed", { code: "P1017", clientVersion: "test" });
  }
  if (currentUpdate.getStore() === 2 && failOnce("receipt-before-commit")) {
    throw new Prisma.PrismaClientKnownRequestError("could not connect", { code: "P1001", clientVersion: "test" });
  }
  const result = await finishUpdate(args);
  if (currentUpdate.getStore() === 3 && failOnce("receipt-after-commit")) {
    throw new Prisma.PrismaClientKnownRequestError("connection closed", { code: "P1017", clientVersion: "test" });
  }
  return result;
}
const findStreamers = prisma.streamer.findMany.bind(prisma.streamer);
prisma.streamer.findMany = (...args) => {
  if (currentUpdate.getStore() === 3 && failOnce("db-outage")) {
    throw new Prisma.PrismaClientKnownRequestError("temporary outage", { code: "P1001", clientVersion: "test" });
  }
  return findStreamers(...args);
};
let setupAttempts = 0;
Api.prototype.setMyCommands = async function () {
  if (this.token === process.env.TELEGRAM_BOT_TOKEN && failOnce("admin-setup-503")) {
    throw new GrammyError("unavailable", { ok: false, error_code: 503, description: "unavailable" }, "setMyCommands", {});
  }
  if (!duplicate && recovering && this.token === process.env.TELEGRAM_PUBLIC_BOT_TOKEN && ++setupAttempts <= 6) {
    process.send({ type: "setup-outage" });
    throw transportError(this.token, "setMyCommands");
  }
  return true;
};
Api.prototype.deleteWebhook = async () => true;
Api.prototype.answerCallbackQuery = async function () {
  process.send({ type: "ack", id: currentUpdate.getStore() });
  return true;
};
Api.prototype.getUpdates = async function (options, signal) {
  if (this.token === process.env.TELEGRAM_PUBLIC_BOT_TOKEN) {
    const pending = JSON.parse(process.env.FIXTURE_UPDATES);
    const offset = options.offset ?? 0;
    process.send({ type: "poll", offset });
    if (duplicate && !recovering && offset === 0) return pending.slice(0, 1);
    if (duplicate && !recovering && offset === 2) await copying;
    const batch = pending.filter(update => update.update_id >= offset).slice(0, options.limit);
    if (batch.length || options.timeout === 0) return batch;
  }
  if (this.token === process.env.TELEGRAM_BOT_TOKEN && !signal && failOnce("shutdown-outage")) {
    throw transportError(this.token, "getUpdates");
  }
  if (this.token === process.env.TELEGRAM_CONVERTER_BOT_TOKEN && !signal && failOnce("converter-shutdown-outage")) {
    throw transportError(this.token, "getUpdates");
  }
  if (signal && !signal.aborted) await new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, 30_000);
    signal.addEventListener("abort", finish, { once: true });
  });
  return [];
};
Api.prototype.sendMessage = async function (_chat, text) {
  if (currentUpdate.getStore() === 4 && failOnce("telegram-rate-limit")) {
    throw new GrammyError("too many requests", { ok: false, error_code: 429, description: "rate limit", parameters: { retry_after: 1 } }, "sendMessage", {});
  }
  process.send({ type: "reply", id: currentUpdate.getStore(), text });
  return { message_id: 1 };
};
let delivered = 0;
Api.prototype.copyMessage = async function (_chat, _from, id) {
  process.send({ type: "copy", id });
  // Hold this transport response until the parent kills the process.
  copyStarted();
  if ((duplicate && !recovering) || ++delivered === 25) await new Promise(() => {});
  return { message_id: id };
};
await import("../src/bot.ts");
