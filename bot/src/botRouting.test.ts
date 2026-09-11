import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { Bot } from "grammy";
import type { MyContext } from "./context.js";

process.env.BOT_TOKEN = "123456:test-token";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH ??= ":memory:";

const { GrammyError, HttpError } = await import("grammy");
const { UNEXPECTED_ERROR_TEXT, createBot, isUnreplyableError } = await import("./bot.js");
const { getPendingRegistration } = await import("./db/repository.js");

interface SentMessage {
  chat_id: number;
  text: string;
}

/**
 * Minimal getMe result, so the bot never calls Telegram to discover itself.
 * Cast because UserFromGetMe gains fields with each Bot API release and this
 * stub only needs the identity bits the handlers actually read.
 */
function botInfoStub() {
  return {
    id: 123456,
    is_bot: true,
    first_name: "Test Habit Bot",
    username: "test_habit_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  } as unknown as Bot<MyContext>["botInfo"];
}

/**
 * A real grammy Bot with the network swapped out, driven through
 * bot.handleUpdate() — the same path a Telegram webhook takes.
 *
 * Asserting on the composer's shape would prove nothing: the risk in routing
 * every handler through bot.chatType("private") is that an update stops
 * matching at all, and only running one end to end can show that.
 */
function makeBot(): { bot: Bot<MyContext>; sent: SentMessage[] } {
  const sent: SentMessage[] = [];
  const bot = createBot();

  bot.botInfo = botInfoStub();

  bot.api.config.use((_prev, method, payload) => {
    if (method === "sendMessage") {
      const p = payload as unknown as { chat_id: number; text: string };
      sent.push({ chat_id: p.chat_id, text: p.text });
    }
    return Promise.resolve({ ok: true, result: { message_id: sent.length } } as any);
  });

  return { bot, sent };
}

let updateId = 1;
let chatId = 700_000;

function privateUpdate(message: Record<string, unknown>) {
  const id = chatId++;
  return {
    update_id: updateId++,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id, type: "private" as const, first_name: "Test" },
      from: { id, is_bot: false, first_name: "Test" },
      ...message,
    },
  } as any;
}

function groupUpdate(message: Record<string, unknown>) {
  const id = chatId++;
  return {
    update_id: updateId++,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: -id, type: "supergroup" as const, title: "Some Group" },
      from: { id, is_bot: false, first_name: "Test" },
      ...message,
    },
  } as any;
}

let harness: ReturnType<typeof makeBot>;
beforeEach(() => {
  harness = makeBot();
});

describe("private chat routing", () => {
  it("still answers /start", async () => {
    const update = privateUpdate({ text: "/start", entities: [{ type: "bot_command", offset: 0, length: 6 }] });
    await harness.bot.handleUpdate(update);

    assert.equal(harness.sent.length, 1);
    assert.match(harness.sent[0]!.text, /Are you setting up a new competition/i);
    assert.equal(getPendingRegistration(update.message.from.id)?.step, "role");
  });

  it("answers a photo instead of dropping it", async () => {
    const update = privateUpdate({
      photo: [{ file_id: "f", file_unique_id: "u", width: 90, height: 90, file_size: 10 }],
    });
    await harness.bot.handleUpdate(update);

    assert.equal(harness.sent.length, 1);
    assert.match(harness.sent[0]!.text, /only read text messages/i);
  });

  it("answers a voice note, a sticker and a document alike", async () => {
    await harness.bot.handleUpdate(
      privateUpdate({ voice: { file_id: "v", file_unique_id: "u", duration: 3 } })
    );
    await harness.bot.handleUpdate(
      privateUpdate({ sticker: { file_id: "s", file_unique_id: "u", width: 1, height: 1, type: "regular", is_animated: false, is_video: false } })
    );
    await harness.bot.handleUpdate(
      privateUpdate({ document: { file_id: "d", file_unique_id: "u" } })
    );

    assert.equal(harness.sent.length, 3);
    for (const message of harness.sent) {
      assert.match(message.text, /only read text messages/i);
    }
  });

  it("routes plain text to the registration handler, not the catch-all", async () => {
    await harness.bot.handleUpdate(privateUpdate({ text: "hello" }));

    assert.equal(harness.sent.length, 1, "the text and catch-all handlers must not both reply");
    assert.doesNotMatch(harness.sent[0]!.text, /only read text messages/i);
  });
});

describe("group chats", () => {
  it("ignores /start rather than starting a personal signup in front of everyone", async () => {
    const update = groupUpdate({
      text: "/start",
      entities: [{ type: "bot_command", offset: 0, length: 6 }],
    });
    await harness.bot.handleUpdate(update);

    assert.equal(harness.sent.length, 0);
    assert.equal(getPendingRegistration(update.message.from.id), undefined);
  });

  it("ignores ordinary group chatter", async () => {
    await harness.bot.handleUpdate(groupUpdate({ text: "salam everyone" }));
    await harness.bot.handleUpdate(groupUpdate({ photo: [{ file_id: "f", file_unique_id: "u", width: 1, height: 1 }] }));

    assert.equal(harness.sent.length, 0);
  });
});

describe("isUnreplyableError", () => {
  function grammyError(errorCode: number, description: string): InstanceType<typeof GrammyError> {
    return new GrammyError(
      "Call to sendMessage failed",
      { ok: false, error_code: errorCode, description },
      "sendMessage",
      {}
    );
  }

  it("is true where replying would just fail again", () => {
    // The user blocked the bot, the chat is gone, or Telegram is throttling us.
    assert.equal(isUnreplyableError(grammyError(403, "Forbidden: bot was blocked by the user")), true);
    assert.equal(isUnreplyableError(grammyError(429, "Too Many Requests: retry after 30")), true);
    assert.equal(isUnreplyableError(grammyError(400, "Bad Request: chat not found")), true);
    assert.equal(isUnreplyableError(new HttpError("Network request failed", new Error("network down"))), true);
  });

  it("is false for the errors a user can actually be told about", () => {
    assert.equal(isUnreplyableError(new Error("SQLITE_BUSY: database is locked")), false);
    assert.equal(isUnreplyableError(grammyError(400, "Bad Request: can't parse entities")), false);
  });
});

describe("bot.catch", () => {
  it("tells the user when a handler threw, instead of only logging", async () => {
    const sent: SentMessage[] = [];
    const bot = createBot();
    bot.botInfo = botInfoStub();

    // The handler's own reply fails once; the fallback reply that follows must
    // still get through. This is the shape of the real failure: a user answers
    // a signup question and the bot goes quiet for good.
    let failNext = true;
    bot.api.config.use((_prev, method, payload) => {
      if (method === "sendMessage") {
        if (failNext) {
          failNext = false;
          throw new Error("Bad Request: something went wrong");
        }
        const p = payload as unknown as { chat_id: number; text: string };
        sent.push({ chat_id: p.chat_id, text: p.text });
      }
      return Promise.resolve({ ok: true, result: { message_id: sent.length } } as any);
    });

    // handleUpdates(), not handleUpdate(): the former is what routes a thrown
    // handler to bot.catch, and it is the path bot.start() long polling uses in
    // production. handleUpdate() on its own rethrows instead.
    // handleUpdates is marked private in the typings but is the method the
    // built-in long-polling loop calls; reached here the same way grammy's own
    // runner does.
    await (bot as unknown as { handleUpdates(updates: unknown[]): Promise<void> }).handleUpdates([
      privateUpdate({ text: "/start", entities: [{ type: "bot_command", offset: 0, length: 6 }] }),
    ]);

    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.text, UNEXPECTED_ERROR_TEXT);
  });
});
