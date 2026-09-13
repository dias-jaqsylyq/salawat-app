import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MyContext } from "../context.js";

process.env.BOT_TOKEN ??= "flow-test";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH ??= ":memory:";

const {
  createRoom,
  createUser,
  getPendingRegistration,
  getRoomById,
  getRoomByPassword,
  getUserByTelegramId,
  ensurePendingRegistration,
  isRoomAdmin,
  leaveCurrentRoom,
  listRoomAdminUserIds,
  updateUserProfile,
} = await import("../db/repository.js");
const { db } = await import("../db/client.js");
const { handleRegistrationAnswer, ADMIN_CHOICE_LABEL, PARTICIPANT_CHOICE_LABEL, parseRole } =
  await import("./flow.js");
const { parseStartPayload, registeredMenuText, registrationTextHandler, startCommand } =
  await import("../commands/start.js");

/**
 * Approximates Telegram Bot API's real legacy-"Markdown" entity parser: a lone
 * unmatched _ or * anywhere in the text makes sendMessage reject with
 * "can't parse entities". A plain always-succeeds reply stub would hide this
 * class of bug entirely (free-text nicknames are never guaranteed balanced).
 */
function assertTelegramMarkdownParses(text: string): void {
  for (const marker of ["_", "*"]) {
    const count = text.split(marker).length - 1;
    if (count % 2 !== 0) {
      throw new Error(
        `Telegram 400: can't parse entities: Can't find end of the entity starting at byte offset ` +
          `${text.indexOf(marker)} (unmatched "${marker}")`
      );
    }
  }
}

function makeCtx(
  telegramId: number,
  messageText?: string
): {
  ctx: MyContext;
  replies: Array<{ text: string; opts: any }>;
} {
  const replies: Array<{ text: string; opts: any }> = [];
  const ctx = {
    from: { id: telegramId, is_bot: false, first_name: "Test", username: `user_${telegramId}` },
    message: messageText ? { text: messageText } : undefined,
    me: { username: "test_habit_bot" },
    reply: async (text: string, opts?: any) => {
      if (opts?.parse_mode === "Markdown") {
        assertTelegramMarkdownParses(text);
      }
      replies.push({ text, opts });
      return {} as any;
    },
  } as unknown as MyContext;
  return { ctx, replies };
}

let nextTelegramId = 950000001;
function makeTelegramId(): number {
  return nextTelegramId++;
}

/** Feed a sequence of answers to whatever step the pending row is on. */
async function answer(ctx: MyContext, telegramId: number, ...texts: string[]): Promise<void> {
  for (const text of texts) {
    await handleRegistrationAnswer(ctx, getPendingRegistration(telegramId)!, text);
  }
}

/** Register an admin with a room, returning the room. */
async function registerAdmin(
  telegramId: number,
  roomName: string,
  nickname: string,
  categories: "Yes" | "No" = "No"
) {
  const { ctx, replies } = makeCtx(telegramId);
  ensurePendingRegistration(telegramId);
  await answer(
    ctx,
    telegramId,
    ADMIN_CHOICE_LABEL,
    `${nickname} Real Name`,
    roomName,
    categories,
    nickname,
    "No", // daily reminder
    "No" // fasting reminder
  );
  const user = getUserByTelegramId(telegramId)!;
  return { user, room: getRoomById(user.current_room_id!)!, replies };
}

describe("parseRole", () => {
  it("accepts the keyboard labels and typed shorthands", () => {
    assert.equal(parseRole(ADMIN_CHOICE_LABEL), "admin");
    assert.equal(parseRole(PARTICIPANT_CHOICE_LABEL), "participant");
    assert.equal(parseRole("Admin"), "admin");
    assert.equal(parseRole(" participant "), "participant");
    assert.equal(parseRole("join"), "participant");
    assert.equal(parseRole("neither"), null);
  });
});

describe("registration flow — admin path", () => {
  it("role -> real_name -> room_name -> categories -> nickname -> reminders creates a room, its password, and its owner", async () => {
    const telegramId = makeTelegramId();
    const { ctx, replies } = makeCtx(telegramId);
    ensurePendingRegistration(telegramId);
    assert.equal(getPendingRegistration(telegramId)!.step, "role");

    await answer(ctx, telegramId, ADMIN_CHOICE_LABEL);
    assert.equal(getPendingRegistration(telegramId)!.step, "real_name");
    assert.equal(getPendingRegistration(telegramId)!.role, "admin");

    await answer(ctx, telegramId, "Dias Admin");
    assert.equal(getPendingRegistration(telegramId)!.step, "room_name");

    await answer(ctx, telegramId, "Mawlid Crew");
    assert.equal(getPendingRegistration(telegramId)!.step, "categories");

    await answer(ctx, telegramId, "Yes");
    assert.equal(getPendingRegistration(telegramId)!.step, "nickname");
    assert.equal(getPendingRegistration(telegramId)!.categories_enabled, 1);

    await answer(ctx, telegramId, "DiasA");
    assert.equal(getPendingRegistration(telegramId)!.step, "reminder_opt_in");

    await answer(ctx, telegramId, "Yes", "21:30");
    assert.equal(getPendingRegistration(telegramId)!.step, "fasting_opt_in");

    await answer(ctx, telegramId, "Yes", "19:00");

    assert.equal(getPendingRegistration(telegramId), undefined);
    const user = getUserByTelegramId(telegramId)!;
    assert.equal(user.role, "admin");
    assert.equal(user.nickname, "DiasA");
    assert.equal(user.real_name, "Dias Admin");
    assert.equal(user.reminder_enabled, 1);
    assert.equal(user.reminder_time, "21:30");
    assert.equal(user.fasting_reminder_enabled, 1);
    assert.equal(user.fasting_reminder_time, "19:00");

    // The room exists, the admin is in it, and owns it.
    const room = getRoomById(user.current_room_id!)!;
    assert.equal(room.name, "Mawlid Crew");
    assert.equal(room.categories_enabled, 1);
    assert.equal(room.owner_user_id, user.id);
    assert.ok(room.password.length >= 6);
    assert.equal(isRoomAdmin(user.id, room.id), true);
    assert.deepEqual(listRoomAdminUserIds(room.id), [user.id]);

    // The password and a working invite deep link are both shown to the admin.
    const last = replies.at(-1)!;
    assert.equal(last.opts?.parse_mode, "HTML");
    assert.match(last.text, new RegExp(room.password));
    assert.match(last.text, /Share this with your participants/i);
    assert.match(last.text, new RegExp(`https://t\\.me/test_habit_bot\\?start=${room.password}`));
  });

  it("stores categories off when the admin declines them", async () => {
    const { room } = await registerAdmin(makeTelegramId(), "Flat Room", "FlatAdmin", "No");
    assert.equal(room.categories_enabled, 0);
  });

  it("rejects an empty room name without advancing the step", async () => {
    const telegramId = makeTelegramId();
    const { ctx, replies } = makeCtx(telegramId);
    ensurePendingRegistration(telegramId);
    await answer(ctx, telegramId, ADMIN_CHOICE_LABEL, "Room Namer");

    await answer(ctx, telegramId, "   ");
    assert.equal(getPendingRegistration(telegramId)!.step, "room_name");
    assert.match(replies.at(-1)!.text, /Room name must be/i);
  });

  it("does not block an admin's nickname on a name taken in someone else's room", async () => {
    const { room } = await registerAdmin(makeTelegramId(), "Room A", "SharedNick");

    // A second admin picks the same nickname — different room, so it's free.
    const { user: second, room: secondRoom } = await registerAdmin(
      makeTelegramId(),
      "Room B",
      "SharedNick"
    );
    assert.equal(second.nickname, "SharedNick");
    assert.notEqual(room.id, secondRoom.id);
  });
});

describe("registration flow — participant path", () => {
  it("password -> real_name -> nickname -> reminders joins the room the password resolved to", async () => {
    const { room } = await registerAdmin(makeTelegramId(), "Join Target", "TargetAdmin");

    const telegramId = makeTelegramId();
    const { ctx, replies } = makeCtx(telegramId);
    ensurePendingRegistration(telegramId);

    await answer(ctx, telegramId, PARTICIPANT_CHOICE_LABEL);
    assert.equal(getPendingRegistration(telegramId)!.step, "room_password");

    await answer(ctx, telegramId, room.password);
    const pending = getPendingRegistration(telegramId)!;
    assert.equal(pending.step, "real_name");
    assert.equal(pending.room_id, room.id);
    assert.match(replies.at(-1)!.text, /Join Target/);

    await answer(ctx, telegramId, "Aisha Joiner", "Aisha", "No", "No");

    assert.equal(getPendingRegistration(telegramId), undefined);
    const user = getUserByTelegramId(telegramId)!;
    assert.equal(user.role, "participant");
    assert.equal(user.current_room_id, room.id);
    assert.equal(user.reminder_enabled, 0);
    assert.equal(user.fasting_reminder_enabled, 0);
    // Joining a room does not make anyone an admin of it.
    assert.equal(isRoomAdmin(user.id, room.id), false);
    assert.match(replies.at(-1)!.text, /Join Target/);
  });

  it("re-prompts on a wrong password and on one that isn't a valid password at all", async () => {
    const telegramId = makeTelegramId();
    const { ctx, replies } = makeCtx(telegramId);
    ensurePendingRegistration(telegramId);
    await answer(ctx, telegramId, PARTICIPANT_CHOICE_LABEL);

    // Well-formed but unknown.
    await answer(ctx, telegramId, "NoSuchPass");
    assert.equal(getPendingRegistration(telegramId)!.step, "room_password");
    assert.equal(getPendingRegistration(telegramId)!.room_id, null);
    assert.match(replies.at(-1)!.text, /No room has that password/i);

    // Too short / illegal characters — same wording, nothing leaked about which
    // guesses were closer.
    await answer(ctx, telegramId, "ab!");
    assert.equal(getPendingRegistration(telegramId)!.step, "room_password");
    assert.match(replies.at(-1)!.text, /No room has that password/i);
  });

  it("treats room passwords as case-sensitive", async () => {
    const { room } = await registerAdmin(makeTelegramId(), "Case Room", "CaseAdmin");
    const flipped = room.password
      .split("")
      .map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()))
      .join("");

    const telegramId = makeTelegramId();
    const { ctx, replies } = makeCtx(telegramId);
    ensurePendingRegistration(telegramId);
    await answer(ctx, telegramId, PARTICIPANT_CHOICE_LABEL, flipped);

    assert.equal(getPendingRegistration(telegramId)!.step, "room_password");
    assert.match(replies.at(-1)!.text, /No room has that password/i);
  });

  it("scopes nickname uniqueness to the room: blocked inside it, free in another", async () => {
    const first = await registerAdmin(makeTelegramId(), "Nick Room", "RoomOwner");
    const other = await registerAdmin(makeTelegramId(), "Other Room", "OtherOwner");

    // Someone joins the first room and takes a nickname.
    const takerId = makeTelegramId();
    const taker = makeCtx(takerId);
    ensurePendingRegistration(takerId);
    await answer(
      taker.ctx,
      takerId,
      PARTICIPANT_CHOICE_LABEL,
      first.room.password,
      "Taker Person",
      "TakenNick",
      "No",
      "No"
    );
    assert.equal(getUserByTelegramId(takerId)!.nickname, "TakenNick");

    // A second joiner of the SAME room can't reuse it.
    const clashId = makeTelegramId();
    const clash = makeCtx(clashId);
    ensurePendingRegistration(clashId);
    await answer(
      clash.ctx,
      clashId,
      PARTICIPANT_CHOICE_LABEL,
      first.room.password,
      "Clash Person",
      "TakenNick"
    );
    assert.equal(getPendingRegistration(clashId)!.step, "nickname");
    assert.match(clash.replies.at(-1)!.text, /already taken in this room/i);

    // ...but a joiner of a DIFFERENT room can (PRD §3a).
    const freeId = makeTelegramId();
    const free = makeCtx(freeId);
    ensurePendingRegistration(freeId);
    await answer(
      free.ctx,
      freeId,
      PARTICIPANT_CHOICE_LABEL,
      other.room.password,
      "Free Person",
      "TakenNick",
      "No",
      "No"
    );
    assert.equal(getUserByTelegramId(freeId)!.nickname, "TakenNick");
    assert.equal(getUserByTelegramId(freeId)!.current_room_id, other.room.id);
  });
});

describe("registration flow — shared steps", () => {
  it("rejects an unrecognized role answer without advancing", async () => {
    const telegramId = makeTelegramId();
    const { ctx, replies } = makeCtx(telegramId);
    ensurePendingRegistration(telegramId);

    await answer(ctx, telegramId, "what?");
    assert.equal(getPendingRegistration(telegramId)!.step, "role");
    assert.match(replies.at(-1)!.text, /tap one of the two buttons/i);
  });

  it("rejects an empty real name without advancing the step", async () => {
    const telegramId = makeTelegramId();
    const { ctx, replies } = makeCtx(telegramId);
    ensurePendingRegistration(telegramId);
    await answer(ctx, telegramId, ADMIN_CHOICE_LABEL);

    await answer(ctx, telegramId, "   ");
    assert.equal(getPendingRegistration(telegramId)!.step, "real_name");
    assert.match(replies.at(-1)!.text, /full name/i);
  });

  it("rejects a nickname matching the real name", async () => {
    const telegramId = makeTelegramId();
    const { ctx, replies } = makeCtx(telegramId);
    ensurePendingRegistration(telegramId);
    await answer(ctx, telegramId, ADMIN_CHOICE_LABEL, "Same Name", "Same Room", "No");

    await answer(ctx, telegramId, "same name");
    assert.equal(getPendingRegistration(telegramId)!.step, "nickname");
    assert.match(replies.at(-1)!.text, /different from your full name/i);
  });

  it("rejects an invalid reminder time without advancing to the fasting question", async () => {
    const telegramId = makeTelegramId();
    const { ctx, replies } = makeCtx(telegramId);
    ensurePendingRegistration(telegramId);
    await answer(ctx, telegramId, ADMIN_CHOICE_LABEL, "Time Tester", "Time Room", "No", "TimeNick");

    await answer(ctx, telegramId, "Yes");
    assert.equal(getPendingRegistration(telegramId)!.step, "reminder_time");

    await answer(ctx, telegramId, "25:99");
    assert.equal(getPendingRegistration(telegramId)!.step, "reminder_time");
    assert.equal(getUserByTelegramId(telegramId), undefined);
    assert.match(replies.at(-1)!.text, /isn't valid/i);
  });

  it("declining the daily reminder still asks the fasting question", async () => {
    const telegramId = makeTelegramId();
    const { ctx } = makeCtx(telegramId);
    ensurePendingRegistration(telegramId);
    await answer(ctx, telegramId, ADMIN_CHOICE_LABEL, "Fast Only", "Fast Room", "No", "FastNick");

    await answer(ctx, telegramId, "No");
    assert.equal(getPendingRegistration(telegramId)!.step, "fasting_opt_in");

    await answer(ctx, telegramId, "Yes", "07:05");
    const user = getUserByTelegramId(telegramId)!;
    assert.equal(user.reminder_enabled, 0);
    assert.equal(user.fasting_reminder_enabled, 1);
    assert.equal(user.fasting_reminder_time, "07:05");
  });

  it("rejects an invalid fasting time without finalizing", async () => {
    const telegramId = makeTelegramId();
    const { ctx, replies } = makeCtx(telegramId);
    ensurePendingRegistration(telegramId);
    await answer(
      ctx,
      telegramId,
      ADMIN_CHOICE_LABEL,
      "Bad Fast Time",
      "Bad Fast Room",
      "No",
      "BadFastNick",
      "No",
      "Yes"
    );
    assert.equal(getPendingRegistration(telegramId)!.step, "fasting_time");

    await answer(ctx, telegramId, "nope");
    assert.equal(getPendingRegistration(telegramId)!.step, "fasting_time");
    assert.equal(getUserByTelegramId(telegramId), undefined);
    assert.match(replies.at(-1)!.text, /isn't valid/i);
  });

  it("finalizes with a nickname containing Markdown-special characters (e.g. an underscore)", async () => {
    // A plain "*nickname*" Markdown reply would 400 on this — see
    // assertTelegramMarkdownParses. The real fix sends HTML with an escaped
    // nickname instead, which this test exercises end to end.
    const { room } = await registerAdmin(makeTelegramId(), "Underscore Room", "UsAdmin");

    const telegramId = makeTelegramId();
    const { ctx, replies } = makeCtx(telegramId);
    ensurePendingRegistration(telegramId);
    await answer(
      ctx,
      telegramId,
      PARTICIPANT_CHOICE_LABEL,
      room.password,
      "Ali Nurlanov",
      "ali_2005",
      "Yes",
      "20:00",
      "No"
    );

    assert.equal(getPendingRegistration(telegramId), undefined);
    assert.equal(getUserByTelegramId(telegramId)?.nickname, "ali_2005");

    const last = replies.at(-1)!;
    assert.equal(last.opts?.parse_mode, "HTML");
    assert.match(last.text, /ali_2005/);
  });

  it("escapes HTML-special characters in a room name rather than sending broken markup", async () => {
    const telegramId = makeTelegramId();
    const { replies } = await registerAdmin(telegramId, "Bros <3 & Co", "AngleAdmin");
    const last = replies.at(-1)!;
    assert.match(last.text, /Bros &lt;3 &amp; Co/);
  });

  it("refuses to finish a signup on top of a live membership, reconciling instead", async () => {
    const telegramId = makeTelegramId();
    // A user who is already fully set up, with a pending signup somehow still
    // open against them. Finishing it would move them out of a room they never
    // left and overwrite the answers they gave when they joined it.
    //
    // The shape this guards used to be a UNIQUE(users.telegram_id) collision
    // caught at finalize. It is a check *before* the write now: finalize writes
    // through registerUser, which updates an existing row rather than colliding
    // with it — that is what lets someone re-register after leaving a room, and
    // it means there is no longer an error to catch here.
    const existing = createUser(telegramId, "Settled");
    const room = createRoom("Settled Room", "settled-room-pass", existing.id);
    const { setUserCurrentRoom } = await import("../db/repository.js");
    setUserCurrentRoom(existing.id, room.id);

    const { ctx, replies } = makeCtx(telegramId);
    ensurePendingRegistration(telegramId);
    await answer(
      ctx,
      telegramId,
      ADMIN_CHOICE_LABEL,
      "Settled Person",
      "Would-Be Room",
      "No",
      "SettledNick",
      "No",
      "No"
    );

    // Told plainly, not scared with a generic error, and the now-useless
    // pending row is cleaned up.
    assert.equal(getPendingRegistration(telegramId), undefined);
    assert.match(replies.at(-1)!.text, /already registered/i);

    // Nothing of theirs moved, and no second room was created for them.
    const after = getUserByTelegramId(telegramId)!;
    assert.equal(after.current_room_id, room.id);
    assert.equal(after.nickname, "Settled");
    assert.equal(getRoomByPassword("would-be-room"), undefined);
  });
});

describe("registering again after leaving a room", () => {
  /** An admin who set a room up, then handed it over and walked out. */
  async function strandedAdmin(roomName: string, nickname: string) {
    const telegramId = makeTelegramId();
    const { user, room } = await registerAdmin(telegramId, roomName, nickname);
    // Somebody has to be able to run the room they are leaving.
    const heir = createUser(makeTelegramId(), `${nickname} Heir`);
    const { setUserCurrentRoom, addRoomAdmin } = await import("../db/repository.js");
    setUserCurrentRoom(heir.id, room.id);
    addRoomAdmin(room.id, heir.id);

    leaveCurrentRoom(user.id);
    assert.equal(getUserByTelegramId(telegramId)!.current_room_id, null);
    return { telegramId, userId: user.id, oldRoom: room };
  }

  it("opens the role question on a bare /start instead of a dead end", async () => {
    const { telegramId } = await strandedAdmin("Left Behind", "Leaver");

    const { ctx, replies } = makeCtx(telegramId, "/start");
    await startCommand(ctx);

    // The bug: this used to be a static "you're not in a room right now" with
    // no way forward, and the Mini App answered it by saying to send /start.
    assert.equal(getPendingRegistration(telegramId)?.step, "role");
    assert.match(replies.at(-1)!.text, /setting up a new competition, or joining one/i);
  });

  it("runs the whole admin branch again and builds a brand new room", async () => {
    const { telegramId, userId, oldRoom } = await strandedAdmin("First Room", "FirstNick");

    const { ctx } = makeCtx(telegramId, "/start");
    await startCommand(ctx);
    await answer(
      ctx,
      telegramId,
      ADMIN_CHOICE_LABEL,
      "Second Life",
      "Second Room",
      "Yes",
      "SecondNick",
      "No",
      "No"
    );

    const after = getUserByTelegramId(telegramId)!;
    const room = getRoomById(after.current_room_id!)!;
    assert.equal(room.name, "Second Room");
    assert.equal(room.categories_enabled, 1);
    assert.notEqual(room.id, oldRoom.id);
    assert.equal(isRoomAdmin(after.id, room.id), true);
    assert.notEqual(after.room_joined_at, null);
    // The same account, not a new one: their history hangs off this id.
    assert.equal(after.id, userId);
    assert.equal(getPendingRegistration(telegramId), undefined);
    // And the room they left is none of this signup's business.
    assert.equal(getRoomById(oldRoom.id)?.name, "First Room");
    assert.equal(isRoomAdmin(after.id, oldRoom.id), false);
  });

  it("runs the participant branch again with the password typed into the chat", async () => {
    const { telegramId, userId } = await strandedAdmin("Origin Room", "OriginNick");
    const destination = (await registerAdmin(makeTelegramId(), "Typed Room", "TypedAdmin")).room;

    const { ctx } = makeCtx(telegramId, "/start");
    await startCommand(ctx);
    assert.equal(getPendingRegistration(telegramId)!.step, "role");

    // No deep link anywhere: the password goes in at the room_password step,
    // exactly as a brand-new participant would send it.
    await answer(ctx, telegramId, PARTICIPANT_CHOICE_LABEL);
    assert.equal(getPendingRegistration(telegramId)!.step, "room_password");
    await answer(ctx, telegramId, destination.password, "Typed Person", "TypedNick", "No", "No");

    const after = getUserByTelegramId(telegramId)!;
    assert.equal(after.current_room_id, destination.id);
    assert.equal(after.id, userId);
    assert.equal(after.role, "participant");
    assert.equal(getPendingRegistration(telegramId), undefined);
  });

  it("asks everything again and carries nothing over", async () => {
    const { telegramId } = await strandedAdmin("Old Habits", "OldNick");
    updateUserProfile(telegramId, {
      realName: "Old Real Name",
      reminderEnabled: true,
      reminderTime: "06:30",
      fastingReminderEnabled: true,
      fastingReminderTime: "21:00",
      timezone: "Asia/Almaty",
      streakDisplay: "current",
      weekStartDay: 0,
    });

    const { ctx } = makeCtx(telegramId, "/start");
    await startCommand(ctx);
    await answer(
      ctx,
      telegramId,
      ADMIN_CHOICE_LABEL,
      "New Real Name",
      "New Habits",
      "No",
      "NewNick",
      "No", // daily reminder off this time
      "No"
    );

    const after = getUserByTelegramId(telegramId)!;
    // Every signup answer is the new one. This is the opposite of a deep-link
    // switch, where the person moves house and their settings travel with them.
    assert.equal(after.nickname, "NewNick");
    assert.equal(after.real_name, "New Real Name");
    assert.equal(after.reminder_enabled, 0);
    assert.equal(after.fasting_reminder_enabled, 0);
    // ...but the things signup never asks about are left exactly alone, rather
    // than silently rearranging the app around someone who wanted a new room.
    assert.equal(after.timezone, "Asia/Almaty");
    assert.equal(after.streak_display, "current");
    assert.equal(after.week_start_day, 0);
  });

  it("lets the role flip, since the question is asked again", async () => {
    const { telegramId } = await strandedAdmin("Was Admin", "WasAdminNick");
    const host = (await registerAdmin(makeTelegramId(), "Host Room", "HostNick")).room;

    const { ctx } = makeCtx(telegramId, "/start");
    await startCommand(ctx);
    await answer(
      ctx,
      telegramId,
      PARTICIPANT_CHOICE_LABEL,
      host.password,
      "Demoted Person",
      "DemotedNick",
      "No",
      "No"
    );

    const after = getUserByTelegramId(telegramId)!;
    assert.equal(after.role, "participant");
    assert.equal(after.current_room_id, host.id);
    // A role is a registration answer, not a permission: being in room_admins
    // is what makes someone an admin, and they are not.
    assert.equal(isRoomAdmin(after.id, host.id), false);
    assert.deepEqual(listRoomAdminUserIds(host.id).includes(after.id), false);
  });

  it("stays shut for a registered user who is still in a room", async () => {
    const telegramId = makeTelegramId();
    const { room } = await registerAdmin(telegramId, "Settled Down", "SettledNick");

    const { ctx, replies } = makeCtx(telegramId, "/start");
    await startCommand(ctx);

    assert.equal(getPendingRegistration(telegramId), undefined);
    assert.match(replies.at(-1)!.text, /Settled Down/);

    // ...and their chatter is still ordinary chatter, not a signup answer.
    const typed = makeCtx(telegramId, ADMIN_CHOICE_LABEL);
    await registrationTextHandler(typed.ctx);
    assert.equal(getPendingRegistration(telegramId), undefined);
    assert.equal(getUserByTelegramId(telegramId)!.current_room_id, room.id);
  });

  it("routes a stray message to the open question, not the menu nudge", async () => {
    const { telegramId } = await strandedAdmin("Stray Room", "StrayNick");

    const { ctx } = makeCtx(telegramId, "/start");
    await startCommand(ctx);

    const stray = makeCtx(telegramId, "what now?");
    await registrationTextHandler(stray.ctx);

    // They are mid-signup like anyone else, so they get the question again.
    assert.match(stray.replies.at(-1)!.text, /setting up a new competition, or joining one/i);
  });
});

describe("/start deep links", () => {
  it("parses a start payload, and only a real one", () => {
    assert.equal(parseStartPayload("/start AbCdEf12"), "AbCdEf12");
    assert.equal(parseStartPayload("/start@my_bot AbCdEf12"), "AbCdEf12");
    assert.equal(parseStartPayload("  /start   AbCdEf12  "), "AbCdEf12");
    assert.equal(parseStartPayload("/start"), null);
    assert.equal(parseStartPayload(undefined), null);
  });

  it("skips the role and password questions for a new user following a room link", async () => {
    const { room } = await registerAdmin(makeTelegramId(), "Deep Link Room", "DeepAdmin");

    const telegramId = makeTelegramId();
    const { ctx, replies } = makeCtx(telegramId, `/start ${room.password}`);
    await startCommand(ctx);

    const pending = getPendingRegistration(telegramId)!;
    assert.equal(pending.step, "real_name");
    assert.equal(pending.role, "participant");
    assert.equal(pending.room_id, room.id);
    assert.match(replies.at(-1)!.text, /Deep Link Room/);

    // ...and the rest of the participant flow runs from there.
    await answer(ctx, telegramId, "Linked Person", "LinkedNick", "No", "No");
    assert.equal(getUserByTelegramId(telegramId)!.current_room_id, room.id);
  });

  it("falls back to the role question when the link's password is unknown", async () => {
    const telegramId = makeTelegramId();
    const { ctx, replies } = makeCtx(telegramId, "/start NotAPassword");
    await startCommand(ctx);

    const pending = getPendingRegistration(telegramId)!;
    assert.equal(pending.step, "role");
    assert.equal(pending.role, null);
    assert.match(replies.at(-1)!.text, /didn't work/i);
  });

  it("replaces a half-finished signup when the user follows an invite link", async () => {
    const { room } = await registerAdmin(makeTelegramId(), "Switch Room", "SwitchAdmin");

    const telegramId = makeTelegramId();
    const { ctx } = makeCtx(telegramId);
    ensurePendingRegistration(telegramId);
    // Started down the admin path, then thought better of it and tapped a link.
    await answer(ctx, telegramId, ADMIN_CHOICE_LABEL, "Changed Mind");
    assert.equal(getPendingRegistration(telegramId)!.role, "admin");

    const linked = makeCtx(telegramId, `/start ${room.password}`);
    await startCommand(linked.ctx);

    const pending = getPendingRegistration(telegramId)!;
    assert.equal(pending.role, "participant");
    assert.equal(pending.room_id, room.id);
    assert.equal(pending.real_name, null);
  });

  it("asks an already-registered user whether to switch, naming both rooms", async () => {
    const owner = createUser(makeTelegramId(), "AlreadyOwner");
    const room = createRoom("Home Room", "HomeRoomPass1", owner.id);
    const { setUserCurrentRoom } = await import("../db/repository.js");
    setUserCurrentRoom(owner.id, room.id);

    const otherRoom = (await registerAdmin(makeTelegramId(), "Someone Else's", "ElseAdmin")).room;

    const { ctx, replies } = makeCtx(owner.telegram_id, `/start ${otherRoom.password}`);
    await startCommand(ctx);

    // A switch is never a signup, and nothing moves until they answer.
    assert.equal(getPendingRegistration(owner.telegram_id), undefined);
    assert.equal(getUserByTelegramId(owner.telegram_id)!.current_room_id, room.id);

    const asked = replies.at(-1)!;
    assert.match(asked.text, /Home Room/);
    assert.match(asked.text, /Someone Else/);
    // Both names live in the text; the buttons stay a plain Yes and No.
    const markup = JSON.stringify(asked.opts.reply_markup);
    assert.match(markup, /"Yes"/);
    assert.doesNotMatch(markup, /Home Room|Someone Else/);
  });

  it("names no room for a registered user who is between rooms", () => {
    assert.match(registeredMenuText(null), /not in a room right now/i);
    assert.match(registeredMenuText("A & B"), /A &amp; B/);
  });
});
