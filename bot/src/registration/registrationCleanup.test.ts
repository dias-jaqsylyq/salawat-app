import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MyContext } from "../context.js";

process.env.BOT_TOKEN ??= "cleanup-test";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH ??= ":memory:";

const {
  ensurePendingRegistration,
  getPendingRegistration,
  getUserByTelegramId,
  listRegistrationMessageIds,
  startPendingRegistrationForRoom,
} = await import("../db/repository.js");
const { handleRegistrationAnswer, promptCurrentStep, ADMIN_CHOICE_LABEL } = await import(
  "./flow.js"
);
const { registrationTextHandler } = await import("../commands/start.js");

interface Harness {
  ctx: MyContext;
  /** Every message id the bot claims to have sent, in order. */
  sent: number[];
  /** Every (chatId, messageId) deleteMessage was called with. */
  deleted: number[];
  /** Message ids deleteMessage should reject, as Telegram does past 48h. */
  undeletable: Set<number>;
  /** Set before each incoming message so the handler sees a realistic update. */
  incoming(text: string, messageId: number): void;
}

/**
 * A ctx whose reply() hands back real, increasing message_ids and whose
 * api.deleteMessage records (and can refuse) what it is asked to delete — the
 * two things the stub in flow.test.ts deliberately leaves out.
 */
function makeHarness(telegramId: number): Harness {
  const sent: number[] = [];
  const deleted: number[] = [];
  const undeletable = new Set<number>();
  let nextBotMessageId = 1000;

  const ctx = {
    from: { id: telegramId, is_bot: false, first_name: "Test", username: `user_${telegramId}` },
    message: undefined as { text: string; message_id: number } | undefined,
    me: { username: "test_habit_bot" },
    reply: async () => {
      const messageId = nextBotMessageId++;
      sent.push(messageId);
      return { message_id: messageId } as any;
    },
    api: {
      deleteMessage: async (chatId: number, messageId: number) => {
        assert.equal(chatId, telegramId);
        if (undeletable.has(messageId)) {
          throw new Error("Bad Request: message can't be deleted");
        }
        deleted.push(messageId);
        return true;
      },
    },
  } as unknown as MyContext;

  return {
    ctx,
    sent,
    deleted,
    undeletable,
    incoming(text: string, messageId: number) {
      (ctx as unknown as { message: unknown }).message = { text, message_id: messageId };
    },
  };
}

let nextTelegramId = 960000001;
function makeTelegramId(): number {
  return nextTelegramId++;
}

/** Answer the current step the way the real text handler does, ids and all. */
async function answer(h: Harness, telegramId: number, text: string, messageId: number) {
  h.incoming(text, messageId);
  await registrationTextHandler(h.ctx);
}

const ADMIN_ANSWERS: string[] = [
  ADMIN_CHOICE_LABEL,
  "Cleanup Admin",
  "Cleanup Room",
  "No", // categories
  "CleanupA",
  "No", // daily reminder
  "No", // fasting reminder
];

async function runAdminSignup(h: Harness, telegramId: number) {
  const pending = ensurePendingRegistration(telegramId);
  await promptCurrentStep(h.ctx, pending);
  let userMessageId = 1;
  for (const text of ADMIN_ANSWERS) {
    await answer(h, telegramId, text, userMessageId++);
  }
}

describe("registration message bookkeeping", () => {
  it("records every question and every answer while the signup is in progress", async () => {
    const telegramId = makeTelegramId();
    const h = makeHarness(telegramId);

    const pending = ensurePendingRegistration(telegramId);
    await promptCurrentStep(h.ctx, pending);
    assert.deepEqual(listRegistrationMessageIds(telegramId), [1000]);

    await answer(h, telegramId, ADMIN_CHOICE_LABEL, 1);
    // The answer plus the next question.
    assert.deepEqual(listRegistrationMessageIds(telegramId), [1, 1000, 1001]);

    // An unknown command mid-signup is part of the mess too.
    await answer(h, telegramId, "/nonsense", 2);
    assert.ok(listRegistrationMessageIds(telegramId).includes(2));
  });

  it("carries ids across the pending row being recreated by an invite link", async () => {
    const telegramId = makeTelegramId();
    const h = makeHarness(telegramId);

    const pending = ensurePendingRegistration(telegramId);
    await promptCurrentStep(h.ctx, pending);
    const before = listRegistrationMessageIds(telegramId);
    assert.equal(before.length, 1);

    // Someone else's room, so the invite link has somewhere to point.
    const ownerTelegramId = makeTelegramId();
    await runAdminSignup(makeHarness(ownerTelegramId), ownerTelegramId);
    const roomId = getUserByTelegramId(ownerTelegramId)!.current_room_id!;

    startPendingRegistrationForRoom(telegramId, roomId);

    // pending_registrations was dropped and recreated; the message log was not.
    assert.deepEqual(listRegistrationMessageIds(telegramId), before);
  });

  it("records nothing once the user is registered", async () => {
    const telegramId = makeTelegramId();
    const h = makeHarness(telegramId);
    await runAdminSignup(h, telegramId);
    assert.equal(getPendingRegistration(telegramId), undefined);

    await answer(h, telegramId, "hello again", 99);
    assert.deepEqual(listRegistrationMessageIds(telegramId), []);
  });
});

describe("registration message cleanup", () => {
  it("deletes the whole conversation but keeps the final confirmation", async () => {
    const telegramId = makeTelegramId();
    const h = makeHarness(telegramId);
    await runAdminSignup(h, telegramId);

    const confirmation = h.sent[h.sent.length - 1]!;
    assert.ok(h.deleted.length > 0);
    assert.ok(
      !h.deleted.includes(confirmation),
      "the confirmation carrying the room password must survive"
    );
    // Every question the bot asked before the confirmation, and every answer.
    for (const messageId of h.sent.slice(0, -1)) {
      assert.ok(h.deleted.includes(messageId), `bot message ${messageId} should be deleted`);
    }
    for (let userMessageId = 1; userMessageId <= ADMIN_ANSWERS.length; userMessageId++) {
      assert.ok(h.deleted.includes(userMessageId), `answer ${userMessageId} should be deleted`);
    }
    assert.deepEqual(listRegistrationMessageIds(telegramId), []);
  });

  it("keeps going when Telegram refuses one of the deletions", async () => {
    const telegramId = makeTelegramId();
    const h = makeHarness(telegramId);
    // The first question and one answer are past Telegram's 48-hour window.
    h.undeletable.add(1000);
    h.undeletable.add(3);

    await runAdminSignup(h, telegramId);

    assert.ok(!h.deleted.includes(1000));
    assert.ok(!h.deleted.includes(3));
    // Everything either side of the refusals still went.
    assert.ok(h.deleted.includes(1));
    assert.ok(h.deleted.includes(ADMIN_ANSWERS.length));
    assert.ok(h.deleted.includes(h.sent[h.sent.length - 2]!));
    // And the log is cleared regardless — a message we cannot delete must not
    // be retried forever.
    assert.deepEqual(listRegistrationMessageIds(telegramId), []);
  });
});
