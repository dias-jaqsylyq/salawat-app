import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MyContext } from "../context.js";

process.env.BOT_TOKEN ??= "message-handling-test";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH ??= ":memory:";

const { createAdminWithRoom, ensurePendingRegistration, getPendingRegistration } = await import(
  "../db/repository.js"
);
const {
  HELP_UNREGISTERED_TEXT,
  UNKNOWN_COMMAND_PREFACE,
  UNSUPPORTED_MESSAGE_PREFACE,
  registrationTextHandler,
  unsupportedMessageHandler,
} = await import("./start.js");

interface Reply {
  text: string;
  opts: any;
}

/**
 * `message` carries whatever the update actually held: `{ text }` for a text
 * message, `{ photo: [...] }` for a photo, and so on. The non-text shapes are
 * what used to reach no handler at all.
 */
function makeCtx(telegramId: number, message: Record<string, unknown> = {}) {
  const replies: Reply[] = [];
  const ctx = {
    from: { id: telegramId, is_bot: false, first_name: "Test" },
    message,
    me: { username: "test_habit_bot" },
    reply: async (text: string, opts?: any) => {
      replies.push({ text, opts });
      return {} as any;
    },
  } as unknown as MyContext;
  return { ctx, replies };
}

let nextId = 900_000;
function freshId(): number {
  return nextId++;
}

/** A fully registered user sitting in a room of their own. */
function registeredUser(telegramId: number): void {
  createAdminWithRoom(
    telegramId,
    `nick-${telegramId}`,
    { telegramUsername: null, telegramFirstName: null, telegramLastName: null },
    "Real Name",
    {
      reminderEnabled: false,
      reminderTime: "20:00",
      fastingReminderEnabled: false,
      fastingReminderTime: "20:00",
    },
    { name: `Room ${telegramId}`, categoriesEnabled: false }
  );
}

describe("unsupportedMessageHandler", () => {
  it("re-asks the current signup question when a photo arrives mid-registration", async () => {
    const telegramId = freshId();
    ensurePendingRegistration(telegramId);

    const { ctx, replies } = makeCtx(telegramId, {
      photo: [{ file_id: "abc", file_unique_id: "u", width: 1, height: 1 }],
    });
    await unsupportedMessageHandler(ctx);

    // The regression this guards: before the catch-all existed, a photo matched
    // no handler and the user got nothing at all while signup sat waiting.
    assert.equal(replies.length, 1);
    assert.match(replies[0]!.text, /only read text messages/i);
    // ...and the question they still have to answer comes with it.
    assert.match(replies[0]!.text, /setting up a new competition, or joining one/i);
    // The pending row is untouched — this is a nudge, not an answer.
    assert.equal(getPendingRegistration(telegramId)?.step, "role");
  });

  it("points a registered user at the menu button for a document", async () => {
    const telegramId = freshId();
    registeredUser(telegramId);

    const { ctx, replies } = makeCtx(telegramId, {
      document: { file_id: "d", file_unique_id: "u", file_name: "notes.pdf" },
    });
    await unsupportedMessageHandler(ctx);

    assert.equal(replies.length, 1);
    assert.ok(replies[0]!.text.startsWith(UNSUPPORTED_MESSAGE_PREFACE));
    assert.match(replies[0]!.text, /menu button/i);
  });

  it("gives the help text to someone who never started", async () => {
    const { ctx, replies } = makeCtx(freshId(), { sticker: { file_id: "s" } });
    await unsupportedMessageHandler(ctx);

    assert.equal(replies.length, 1);
    assert.ok(replies[0]!.text.includes(HELP_UNREGISTERED_TEXT));
  });

  it("stays silent for an update with no sender", async () => {
    const replies: Reply[] = [];
    const ctx = {
      from: undefined,
      message: { photo: [] },
      reply: async (text: string, opts?: any) => {
        replies.push({ text, opts });
        return {} as any;
      },
    } as unknown as MyContext;

    await unsupportedMessageHandler(ctx);
    assert.equal(replies.length, 0);
  });
});

describe("registrationTextHandler", () => {
  it("answers an unknown command instead of ignoring it", async () => {
    const { ctx, replies } = makeCtx(freshId(), { text: "/frobnicate" });
    await registrationTextHandler(ctx);

    assert.equal(replies.length, 1);
    assert.ok(replies[0]!.text.startsWith(UNKNOWN_COMMAND_PREFACE));
  });

  it("nudges a registered user who types random text", async () => {
    const telegramId = freshId();
    registeredUser(telegramId);

    const { ctx, replies } = makeCtx(telegramId, { text: "hello?" });
    await registrationTextHandler(ctx);

    assert.equal(replies.length, 1);
    assert.match(replies[0]!.text, /menu button/i);
  });

  it("still records a real answer mid-registration", async () => {
    const telegramId = freshId();
    ensurePendingRegistration(telegramId);

    const { ctx, replies } = makeCtx(telegramId, { text: "admin" });
    await registrationTextHandler(ctx);

    assert.equal(getPendingRegistration(telegramId)?.role, "admin");
    assert.ok(replies.length > 0);
  });

  it("answers someone who has never started rather than going silent", async () => {
    const { ctx, replies } = makeCtx(freshId(), { text: "hello" });
    await registrationTextHandler(ctx);

    assert.equal(replies.length, 1);
    assert.ok(replies[0]!.text.includes(HELP_UNREGISTERED_TEXT));
  });
});
