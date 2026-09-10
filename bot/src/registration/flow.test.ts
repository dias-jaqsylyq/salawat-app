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
  getUserByTelegramId,
  ensurePendingRegistration,
  isRoomAdmin,
  listRoomAdminUserIds,
} = await import("../db/repository.js");
const { db } = await import("../db/client.js");
const { handleRegistrationAnswer, ADMIN_CHOICE_LABEL, PARTICIPANT_CHOICE_LABEL, parseRole } =
  await import("./flow.js");
const { parseStartPayload, registeredMenuText, startCommand } = await import(
  "../commands/start.js"
);

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

  it("reconciles instead of erroring when a users row already exists for this telegram_id " +
    "(the only constraint the users INSERT can violate), logging the real SQL error either way",
  async () => {
    const telegramId = makeTelegramId();
    // A stale/pre-existing users row for this telegram_id — the exact condition
    // reproduced for the live "Something went wrong finishing your signup" report
    // (a users row survived from before this signup attempt, so the INSERT hits
    // UNIQUE(users.telegram_id) at finalize time).
    db.prepare("INSERT INTO users (telegram_id, nickname) VALUES (?, ?)").run(
      telegramId,
      "Collision"
    );

    const { ctx, replies } = makeCtx(telegramId);
    ensurePendingRegistration(telegramId);

    const originalConsoleError = console.error;
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      await answer(
        ctx,
        telegramId,
        ADMIN_CHOICE_LABEL,
        "Collision Person",
        "Collision Room",
        "No",
        "CollisionNick",
        "Yes",
        "20:00",
        "No"
      );
    } finally {
      console.error = originalConsoleError;
    }

    // The real SQL error and a diagnostic snapshot must be logged, not just
    // "something failed" — this is what makes the next occurrence diagnosable.
    const logged = errors.map((args) => args.map(String).join(" ")).join("\n");
    assert.match(logged, /finalizeRegistration/);
    assert.match(logged, /UNIQUE constraint failed: users\.telegram_id/);
    assert.match(logged, /users row already exists for this telegram_id\? true/);
    assert.match(logged, /nickname .* taken by someone else\? false/);

    // Self-healing: the stale collision means the account already exists, so
    // this isn't a scary failure — clean up the now-redundant pending row and
    // tell the user plainly, instead of "something went wrong".
    assert.equal(getPendingRegistration(telegramId), undefined);
    assert.match(replies.at(-1)!.text, /already registered/i);

    // The failed signup left no half-created room behind.
    assert.equal(getUserByTelegramId(telegramId)!.current_room_id, null);
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

  it("ignores the payload entirely for an already-registered user, naming their room", async () => {
    const owner = createUser(makeTelegramId(), "AlreadyOwner");
    const room = createRoom("Home Room", "HomeRoomPass1", owner.id);
    const { setUserCurrentRoom } = await import("../db/repository.js");
    setUserCurrentRoom(owner.id, room.id);

    const otherRoom = (await registerAdmin(makeTelegramId(), "Someone Else's", "ElseAdmin")).room;

    const { ctx, replies } = makeCtx(owner.telegram_id, `/start ${otherRoom.password}`);
    await startCommand(ctx);

    // No signup started, no room switch offered — just the menu nudge.
    assert.equal(getPendingRegistration(owner.telegram_id), undefined);
    assert.equal(getUserByTelegramId(owner.telegram_id)!.current_room_id, room.id);
    assert.match(replies.at(-1)!.text, /Home Room/);
    assert.doesNotMatch(replies.at(-1)!.text, /Someone Else/);
  });

  it("names no room for a registered user who is between rooms", () => {
    assert.match(registeredMenuText(null), /not in a room right now/i);
    assert.match(registeredMenuText("A & B"), /A &amp; B/);
  });
});
