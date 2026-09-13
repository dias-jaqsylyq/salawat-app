import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MyContext } from "../context.js";

process.env.BOT_TOKEN ??= "room-switch-test";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH ??= ":memory:";

const {
  addRoomAdmin,
  createHabit,
  createPersonalHabit,
  createRoom,
  createUser,
  getPendingRegistration,
  getRoomById,
  getUserByTelegramId,
  getUserTotalPoints,
  listPersonalHabits,
  setUserCurrentRoom,
  updateUserProfile,
  upsertHabitLog,
} = await import("../db/repository.js");
const { db } = await import("../db/client.js");
const { config } = await import("../config.js");
const {
  helpCommand,
  registrationTextHandler,
  startCommand,
  unsupportedMessageHandler,
} = await import("../commands/start.js");
const { ADMIN_CHOICE_LABEL } = await import("./flow.js");
const { getRoomSwitchState } = await import("./roomSwitch.js");

let nextTelegramId = 970000001;
let nextMessageId = 1;

interface Chat {
  ctx: (text?: string) => MyContext;
  replies: Array<{ text: string; opts: any }>;
  telegramId: number;
}

/**
 * One user's chat with the bot. Every context shares a chat id and hands out a
 * fresh message id, so the deletion queue can be asserted against a real
 * conversation rather than a single message.
 */
function makeChat(telegramId: number): Chat {
  const replies: Array<{ text: string; opts: any }> = [];
  const ctx = (text?: string) =>
    ({
      from: { id: telegramId, is_bot: false, first_name: "Test" },
      chat: { id: telegramId, type: "private" },
      message: text === undefined ? undefined : { text, message_id: nextMessageId++ },
      me: { username: "test_habit_bot" },
      reply: async (replyText: string, opts?: any) => {
        replies.push({ text: replyText, opts });
        return { message_id: nextMessageId++ } as any;
      },
    }) as unknown as MyContext;
  return { ctx, replies, telegramId };
}

/** A room with an admin inside it, the shape registration leaves behind. */
function makeRoom(name: string, password: string) {
  const owner = createUser(nextTelegramId++, `${name} admin`);
  const room = createRoom(name, password, owner.id);
  setUserCurrentRoom(owner.id, room.id);
  return { room, owner };
}

/** A registered member of `roomId`, or of nowhere when it is null. */
function makeMember(nickname: string, roomId: number | null) {
  const user = createUser(nextTelegramId++, nickname);
  if (roomId !== null) setUserCurrentRoom(user.id, roomId);
  return { user, chat: makeChat(user.telegram_id) };
}

function queuedDeletions(telegramId: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM scheduled_message_deletions WHERE chat_id = ?")
    .get(telegramId) as { n: number };
  return row.n;
}

function keyboardLabels(opts: any): string[] {
  const rows = opts?.reply_markup?.keyboard ?? [];
  return rows.flat().map((button: any) => (typeof button === "string" ? button : button.text));
}

describe("deep link for a user who is between rooms", () => {
  it("joins them straight away, with nothing to confirm", async () => {
    const { room } = makeRoom("Comeback Room", "comeback-room-pass");
    const { user, chat } = makeMember("Returner", null);

    await startCommand(chat.ctx(`/start comeback-room-pass`));

    // The bug this fixes: leaving a room used to be a one-way door, because
    // /start threw the payload away for anyone who already had an account.
    assert.equal(getUserByTelegramId(user.telegram_id)?.current_room_id, room.id);
    const welcome = chat.replies.at(-1)!;
    assert.match(welcome.text, /Comeback Room/);
    // Nothing to stay in means nothing to ask.
    assert.deepEqual(keyboardLabels(welcome.opts), []);
    assert.equal(getRoomSwitchState(user.telegram_id), undefined);
  });

  it("abandons a half-typed re-registration when an invite link arrives", async () => {
    const { room } = makeRoom("Link Wins Room", "link-wins-room-pass");
    const { user, chat } = makeMember("Changed Mind", null);

    // A bare /start opens the whole signup again for someone between rooms...
    await startCommand(chat.ctx("/start"));
    assert.equal(getPendingRegistration(user.telegram_id)?.step, "role");

    // ...and then they remember they have a link. The newer intent wins.
    await startCommand(chat.ctx(`/start link-wins-room-pass`));

    assert.equal(getUserByTelegramId(user.telegram_id)?.current_room_id, room.id);
    // Left behind, that row would be resumed by some later /start and finish
    // into a room change nobody asked for.
    assert.equal(getPendingRegistration(user.telegram_id), undefined);

    const later = makeChat(user.telegram_id);
    await startCommand(later.ctx("/start"));
    assert.match(later.replies.at(-1)!.text, /Link Wins Room/);
  });

  it("leaves a half-typed re-registration alone when the link opens nothing", async () => {
    const { user, chat } = makeMember("Butterfingers", null);

    await startCommand(chat.ctx("/start"));
    await registrationTextHandler(chat.ctx(ADMIN_CHOICE_LABEL));
    assert.equal(getPendingRegistration(user.telegram_id)?.step, "real_name");

    await startCommand(chat.ctx("/start not-a-real-password"));

    // A mistyped or expired link supersedes nothing, and must not cost them
    // the answers they have already given.
    assert.match(chat.replies.at(-1)!.text, /didn't work/i);
    assert.equal(getPendingRegistration(user.telegram_id)?.step, "real_name");
  });

  it("answers an unusable link without starting a signup", async () => {
    const { user, chat } = makeMember("Mistyper", null);

    await startCommand(chat.ctx("/start not-a-real-password"));

    assert.equal(getUserByTelegramId(user.telegram_id)?.current_room_id, null);
    assert.match(chat.replies.at(-1)!.text, /didn't work/i);
    assert.equal(getRoomSwitchState(user.telegram_id), undefined);
  });
});

describe("deep link for a user who is already in a room", () => {
  it("says so when the link is for the room they are in", async () => {
    const { room } = makeRoom("Own Room", "own-room-pass");
    const { user, chat } = makeMember("Homebody", room.id);

    await startCommand(chat.ctx("/start own-room-pass"));

    assert.match(chat.replies.at(-1)!.text, /already in/i);
    assert.equal(getUserByTelegramId(user.telegram_id)?.current_room_id, room.id);
    assert.equal(getRoomSwitchState(user.telegram_id), undefined);
  });

  it("asks about another room's link, naming both rooms in the text only", async () => {
    const from = makeRoom("Old Room", "old-room-switch-pass");
    const to = makeRoom("New Room", "new-room-switch-pass");
    const { user, chat } = makeMember("Undecided", from.room.id);

    await startCommand(chat.ctx("/start new-room-switch-pass"));

    const asked = chat.replies.at(-1)!;
    assert.match(asked.text, /Old Room/);
    assert.match(asked.text, /New Room/);
    // Room names are free text and can be anything at all; the buttons stay
    // two words nobody can make unreadable.
    assert.deepEqual(keyboardLabels(asked.opts), ["Yes", "No"]);
    assert.doesNotMatch(JSON.stringify(asked.opts.reply_markup), /Old Room|New Room/);
    assert.equal(getRoomSwitchState(user.telegram_id)?.kind, "confirm");
    assert.equal(getUserByTelegramId(user.telegram_id)?.current_room_id, from.room.id);
    assert.equal(to.room.id !== from.room.id, true);
  });

  it("keeps everything as it was when they say no", async () => {
    const from = makeRoom("Staying Room", "staying-room-pass");
    makeRoom("Ignored Room", "ignored-room-pass");
    const { user, chat } = makeMember("Loyal", from.room.id);

    await startCommand(chat.ctx("/start ignored-room-pass"));
    await registrationTextHandler(chat.ctx("No"));

    assert.match(chat.replies.at(-1)!.text, /staying in/i);
    assert.match(chat.replies.at(-1)!.text, /Staying Room/);
    assert.equal(getUserByTelegramId(user.telegram_id)?.current_room_id, from.room.id);
    assert.equal(getRoomSwitchState(user.telegram_id), undefined);
  });

  it("moves them on yes, taking what they earned in the old room with them", async () => {
    const from = makeRoom("Abandoned Room", "abandoned-room-pass");
    const to = makeRoom("Chosen Room", "chosen-room-pass");
    const { user, chat } = makeMember("Switcher", from.room.id);
    const habit = createHabit(from.room.id, "Old habit", "quantity", 2);
    upsertHabitLog(user.id, habit.id, 5, "2026-09-01");
    createPersonalHabit(user.id, from.room.id, "Old personal", "binary", null);

    await startCommand(chat.ctx("/start chosen-room-pass"));
    await registrationTextHandler(chat.ctx("Yes"));

    assert.equal(getUserByTelegramId(user.telegram_id)?.current_room_id, to.room.id);
    assert.equal(getUserTotalPoints(user.id, from.room.id), 0);
    assert.equal(listPersonalHabits(user.id, from.room.id).length, 0);

    const welcome = chat.replies.at(-1)!;
    assert.match(welcome.text, /Chosen Room/);
    // The plain new-room welcome: they were told what they were giving up
    // before they agreed, and don't need it recapped afterwards.
    assert.doesNotMatch(welcome.text, /Abandoned Room/);
    assert.equal(getRoomSwitchState(user.telegram_id), undefined);
  });

  it("deletes the room they leave when they were its admin and its only member", async () => {
    const from = makeRoom("One Man Room", "one-man-room-pass");
    const to = makeRoom("Somewhere Busier", "somewhere-busier-pass");
    const chat = makeChat(from.owner.telegram_id);
    createHabit(from.room.id, "Lonely habit", "binary", 1);

    await startCommand(chat.ctx("/start somewhere-busier-pass"));
    await registrationTextHandler(chat.ctx("Yes"));

    // The one case where a room is deleted at all: leaving it standing would
    // strand a room with nobody in it and nobody able to run it.
    assert.equal(getRoomById(from.room.id), undefined);
    assert.equal(getUserByTelegramId(from.owner.telegram_id)?.current_room_id, to.room.id);
  });

  it("refuses the last admin of a room that still has people in it", async () => {
    const from = makeRoom("Needy Room", "needy-room-pass");
    const to = makeRoom("Escape Room", "escape-room-pass");
    const { user: member } = makeMember("Left Behind", from.room.id);
    const chat = makeChat(from.owner.telegram_id);

    await startCommand(chat.ctx("/start escape-room-pass"));
    await registrationTextHandler(chat.ctx("Yes"));

    const refusal = chat.replies.at(-1)!;
    assert.match(refusal.text, /only admin/i);
    assert.match(refusal.text, /Mini App/);
    assert.match(refusal.text, /same invite link again/);
    assert.equal(getUserByTelegramId(from.owner.telegram_id)?.current_room_id, from.room.id);
    assert.equal(getRoomById(from.room.id)?.id, from.room.id);

    // Exactly what the refusal told them to do, and the same link again.
    addRoomAdmin(from.room.id, member.id);
    await startCommand(chat.ctx("/start escape-room-pass"));
    await registrationTextHandler(chat.ctx("Yes"));

    assert.equal(getUserByTelegramId(from.owner.telegram_id)?.current_room_id, to.room.id);
    assert.equal(getRoomById(from.room.id)?.id, from.room.id);
  });
});

describe("a room-switch question nobody answers", () => {
  it("is dropped by anything else the user says, and never asked twice", async () => {
    const from = makeRoom("Distracted Room", "distracted-room-pass");
    makeRoom("Unwanted Room", "unwanted-room-pass");
    const { user, chat } = makeMember("Distracted", from.room.id);

    await startCommand(chat.ctx("/start unwanted-room-pass"));
    await registrationTextHandler(chat.ctx("how many points do I have"));

    assert.equal(getRoomSwitchState(user.telegram_id), undefined);
    // Handled as the ordinary message it is — not re-asked.
    assert.doesNotMatch(chat.replies.at(-1)!.text, /Switch to/);
    assert.match(chat.replies.at(-1)!.text, /Distracted Room/);

    // And a late "Yes" is just another message now.
    await registrationTextHandler(chat.ctx("Yes"));
    assert.equal(getUserByTelegramId(user.telegram_id)?.current_room_id, from.room.id);
  });

  it("is dropped by a command, a sticker, /help and a bare /start alike", async () => {
    const from = makeRoom("Interrupted Room", "interrupted-room-pass");
    makeRoom("Passed Over Room", "passed-over-room-pass");

    for (const interrupt of ["command", "sticker", "help", "start"] as const) {
      const { user, chat } = makeMember(`Interrupted ${interrupt}`, from.room.id);
      await startCommand(chat.ctx("/start passed-over-room-pass"));
      assert.equal(getRoomSwitchState(user.telegram_id)?.kind, "confirm");

      if (interrupt === "command") await registrationTextHandler(chat.ctx("/nonsense"));
      if (interrupt === "sticker") await unsupportedMessageHandler(chat.ctx());
      if (interrupt === "help") await helpCommand(chat.ctx("/help"));
      if (interrupt === "start") await startCommand(chat.ctx("/start"));

      assert.equal(getRoomSwitchState(user.telegram_id), undefined, interrupt);
      await registrationTextHandler(chat.ctx("Yes"));
      assert.equal(
        getUserByTelegramId(user.telegram_id)?.current_room_id,
        from.room.id,
        interrupt
      );
    }
  });

  it("stops being answerable once it is old enough to have been deleted", async () => {
    const from = makeRoom("Forgotten Room", "forgotten-room-pass");
    makeRoom("Too Late Room", "too-late-room-pass");
    const { user, chat } = makeMember("Slow", from.room.id);

    await startCommand(chat.ctx("/start too-late-room-pass"));
    // Age the question past the window its own message survives for.
    getRoomSwitchState(user.telegram_id)!.askedAt =
      Date.now() - config.reminderDeleteAfterMinutes * 60_000 - 1;

    await registrationTextHandler(chat.ctx("Yes"));

    assert.equal(getUserByTelegramId(user.telegram_id)?.current_room_id, from.room.id);
  });

  it("is replaced, not doubled, by tapping another link", async () => {
    const from = makeRoom("Original Room", "original-room-pass");
    const second = makeRoom("Second Choice", "second-choice-pass");
    makeRoom("First Choice", "first-choice-pass");
    const { user, chat } = makeMember("Fickle", from.room.id);

    await startCommand(chat.ctx("/start first-choice-pass"));
    await startCommand(chat.ctx("/start second-choice-pass"));
    await registrationTextHandler(chat.ctx("Yes"));

    assert.equal(getUserByTelegramId(user.telegram_id)?.current_room_id, second.room.id);
  });

  it("does nothing the second time yes is sent", async () => {
    const from = makeRoom("Eager Room", "eager-room-pass");
    const to = makeRoom("Twice Room", "twice-room-pass");
    const { user, chat } = makeMember("Eager", from.room.id);

    await startCommand(chat.ctx("/start twice-room-pass"));
    await registrationTextHandler(chat.ctx("Yes"));
    const joinedAt = getUserByTelegramId(user.telegram_id)!.room_joined_at;

    await registrationTextHandler(chat.ctx("Yes"));

    assert.equal(getUserByTelegramId(user.telegram_id)?.current_room_id, to.room.id);
    // A second yes must not read as a fresh join to the weekly view.
    assert.equal(getUserByTelegramId(user.telegram_id)!.room_joined_at, joinedAt);
  });
});

describe("a nickname already taken in the new room", () => {
  it("is asked about before anything moves, then completes the switch", async () => {
    const from = makeRoom("Duplicate From", "duplicate-from-pass");
    const to = makeRoom("Duplicate To", "duplicate-to-pass");
    makeMember("Taken", to.room.id);
    const { user, chat } = makeMember("taken", from.room.id);
    // Uniqueness in the new room is the only thing checked here — unlike
    // signup, the nickname is not weighed against the real name.
    updateUserProfile(user.telegram_id, { realName: "Fresh Name" });

    await startCommand(chat.ctx("/start duplicate-to-pass"));
    await registrationTextHandler(chat.ctx("Yes"));

    assert.match(chat.replies.at(-1)!.text, /already taken/i);
    assert.equal(getRoomSwitchState(user.telegram_id)?.kind, "nickname");
    // Nothing is written until they have a nickname that works over there.
    assert.equal(getUserByTelegramId(user.telegram_id)?.current_room_id, from.room.id);

    await registrationTextHandler(chat.ctx("Fresh Name"));

    const after = getUserByTelegramId(user.telegram_id)!;
    assert.equal(after.current_room_id, to.room.id);
    assert.equal(after.nickname, "Fresh Name");
    assert.match(chat.replies.at(-1)!.text, /Duplicate To/);
    assert.equal(getRoomSwitchState(user.telegram_id), undefined);
  });

  it("keeps asking, as many times as it takes", async () => {
    const to = makeRoom("Persistent Room", "persistent-room-pass");
    makeMember("Occupied", to.room.id);
    const { user, chat } = makeMember("occupied", null);

    await startCommand(chat.ctx("/start persistent-room-pass"));
    assert.equal(getRoomSwitchState(user.telegram_id)?.kind, "nickname");

    await registrationTextHandler(chat.ctx("   "));
    assert.match(chat.replies.at(-1)!.text, /1–50 characters/);
    await registrationTextHandler(chat.ctx("x".repeat(51)));
    assert.match(chat.replies.at(-1)!.text, /1–50 characters/);
    await registrationTextHandler(chat.ctx("OCCUPIED"));
    assert.match(chat.replies.at(-1)!.text, /taken/i);
    assert.equal(getUserByTelegramId(user.telegram_id)?.current_room_id, null);

    await registrationTextHandler(chat.ctx("Vacant"));
    assert.equal(getUserByTelegramId(user.telegram_id)?.current_room_id, to.room.id);
  });
});

describe("the dialog's own messages", () => {
  it("are all queued for deletion, the welcome included", async () => {
    const from = makeRoom("Tidy From", "tidy-from-pass");
    makeRoom("Tidy To", "tidy-to-pass");
    const { user, chat } = makeMember("Tidy", from.room.id);

    await startCommand(chat.ctx("/start tidy-to-pass"));
    await registrationTextHandler(chat.ctx("Yes"));

    // Two of theirs (the link, the yes) and two of ours (the question, the
    // welcome) — the whole exchange goes, not just the questions.
    assert.equal(queuedDeletions(user.telegram_id), 4);
    const due = db
      .prepare(
        `SELECT COUNT(*) AS n FROM scheduled_message_deletions
         WHERE chat_id = ? AND delete_at > datetime('now', ?)`
      )
      .get(user.telegram_id, `+${config.reminderDeleteAfterMinutes - 1} minutes`) as { n: number };
    assert.equal(due.n, 4);
  });

  it("do not include a message that was never part of the dialog", async () => {
    const from = makeRoom("Untidy From", "untidy-from-pass");
    makeRoom("Untidy To", "untidy-to-pass");
    const { user, chat } = makeMember("Untidy", from.room.id);

    await startCommand(chat.ctx("/start untidy-to-pass"));
    const afterQuestion = queuedDeletions(user.telegram_id);
    await registrationTextHandler(chat.ctx("never mind"));

    // The message that walked away from the question is ordinary traffic, and
    // so is the reply it got.
    assert.equal(queuedDeletions(user.telegram_id), afterQuestion);
  });
});
