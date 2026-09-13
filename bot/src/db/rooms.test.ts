import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.BOT_TOKEN ??= "rooms-test";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH ??= ":memory:";

const {
  addRoomAdmin,
  countRoomAdmins,
  createHabit,
  createPersonalHabit,
  createRoom,
  createUser,
  deleteRoom,
  demoteRoomAdmin,
  getExportRows,
  getHabitById,
  getLeaderboard,
  getRoomById,
  getRoomByPassword,
  getUserByTelegramId,
  getUserTotalPoints,
  getUsersWithRemindersEnabled,
  isLastAdminWithMembers,
  isNicknameTaken,
  isRoomAdmin,
  kickUserFromRoom,
  leaveCurrentRoom,
  listHabits,
  listPersonalHabits,
  listRoomAdminUserIds,
  getParticipantCount,
  regenerateRoomPassword,
  registerUser,
  removeRoomAdmin,
  setRoomCategoriesEnabled,
  setUserCurrentRoom,
  switchRoomWithKick,
  updateHabit,
  updateRoomPassword,
  updateUserProfile,
  upsertHabitLog,
  upsertPersonalHabitLog,
} = await import("./repository.js");
const { db } = await import("./client.js");

let nextTelegramId = 800000001;
function makeUser(nickname?: string) {
  const telegramId = nextTelegramId++;
  return createUser(telegramId, nickname ?? `rooms-tester-${telegramId}`);
}

/** A room with its owner already inside it, the shape registration will produce. */
function makeRoom(name: string, password: string, categoriesEnabled = false) {
  const owner = makeUser();
  const room = createRoom(name, password, owner.id, categoriesEnabled);
  setUserCurrentRoom(owner.id, room.id);
  return { room, owner };
}

describe("createRoom", () => {
  it("records the owner and makes them the room's first admin", () => {
    const owner = makeUser();
    const room = createRoom("Ramadan crew", "crew-password", owner.id);

    assert.equal(room.name, "Ramadan crew");
    assert.equal(room.owner_user_id, owner.id);
    assert.equal(room.categories_enabled, 0);
    assert.equal(isRoomAdmin(owner.id, room.id), true);
    // A room never exists with zero admins — that is what last-admin protection
    // (PRD §3a) is defending, so it has to hold from the moment of creation.
    assert.equal(countRoomAdmins(room.id), 1);
  });

  it("accepts two rooms with the same name — only the id disambiguates them", () => {
    const first = makeRoom("Duplicate name", "duplicate-name-pass-1");
    const second = makeRoom("Duplicate name", "duplicate-name-pass-2");

    assert.notEqual(first.room.id, second.room.id);
    assert.equal(first.room.name, second.room.name);
  });

  it("refuses to reuse a password already in use by another room", () => {
    makeRoom("First room", "shared-password");
    const owner = makeUser();

    // A password has to resolve to exactly one room, so this is a DB-level
    // guarantee rather than a check the join flow could forget.
    assert.throws(
      () => createRoom("Second room", "shared-password", owner.id),
      /UNIQUE constraint failed: rooms.password/
    );
  });
});

describe("getRoomByPassword", () => {
  it("resolves the exact password and is case-sensitive", () => {
    const { room } = makeRoom("Case room", "SecretPass");

    assert.equal(getRoomByPassword("SecretPass")?.id, room.id);
    // `ABC` != `abc` (PRD §3a): a near-miss must not let anyone in.
    assert.equal(getRoomByPassword("secretpass"), undefined);
    assert.equal(getRoomByPassword("SECRETPASS"), undefined);
    assert.equal(getRoomByPassword("nobody-has-this"), undefined);
  });

  it("regenerating a password blocks the old one without touching membership", () => {
    const { room, owner } = makeRoom("Rotating room", "old-password");

    updateRoomPassword(room.id, "new-password");

    assert.equal(getRoomByPassword("old-password"), undefined);
    assert.equal(getRoomByPassword("new-password")?.id, room.id);
    // Everyone who already joined stays in, no re-verification (PRD §3a).
    assert.equal(getUserByTelegramId(owner.telegram_id)?.current_room_id, room.id);
    assert.equal(isRoomAdmin(owner.id, room.id), true);
  });
});

describe("room categories", () => {
  it("toggles on and off while preserving each habit's stored category", () => {
    const { room } = makeRoom("Category room", "category-room-pass", true);
    const habit = createHabit(room.id, "Qur'an pages", "quantity", 2, "IQ");
    assert.equal(habit.category, "IQ");

    setRoomCategoriesEnabled(room.id, false);
    assert.equal(getRoomById(room.id)?.categories_enabled, 0);
    // Switched off means "not used for grouping", not "erased" (PRD §0) — the
    // value survives so re-enabling can offer it back as a pre-fill.
    assert.equal(getHabitById(habit.id)?.category, "IQ");

    setRoomCategoriesEnabled(room.id, true);
    assert.equal(getRoomById(room.id)?.categories_enabled, 1);
    assert.equal(getHabitById(habit.id)?.category, "IQ");
  });

  it("stores a habit with no category in a room that has categories off", () => {
    const { room } = makeRoom("Flat room", "flat-room-pass");
    const habit = createHabit(room.id, "Fasted today", "binary", 5);
    assert.equal(habit.category, null);

    assert.equal(updateHabit(habit.id, { category: "SQ" }).category, "SQ");
    assert.equal(updateHabit(habit.id, { category: null }).category, null);
  });

  it("rejects a category outside the fixed IQ/SQ/PQ/EQ set", () => {
    const { room } = makeRoom("Strict room", "strict-room-pass", true);

    assert.throws(
      () => createHabit(room.id, "Bad category", "binary", 1, "XQ" as never),
      /CHECK constraint failed/
    );
  });
});

describe("room-scoped habits and logs", () => {
  it("lists only the room's own habits", () => {
    const a = makeRoom("Room A", "room-a-pass");
    const b = makeRoom("Room B", "room-b-pass");
    const habitA = createHabit(a.room.id, "A habit", "binary", 1);
    const habitB = createHabit(b.room.id, "B habit", "binary", 1);

    assert.deepEqual(listHabits({ roomId: a.room.id }).map((h) => h.id), [habitA.id]);
    assert.deepEqual(listHabits({ roomId: b.room.id }).map((h) => h.id), [habitB.id]);
  });

  it("stamps each log with its habit's room", () => {
    const { room, owner } = makeRoom("Stamping room", "stamping-room-pass");
    const habit = createHabit(room.id, "Dhikr", "quantity", 3);

    const log = upsertHabitLog(owner.id, habit.id, 10, "2026-08-01");

    assert.equal(log.room_id, room.id);
    assert.equal(log.points_earned, 30);
    assert.equal(getUserTotalPoints(owner.id, room.id), 30);
  });

  it("keeps a moved member's old logs attached to the room they were earned in", () => {
    const from = makeRoom("Old room", "old-room-pass");
    const to = makeRoom("New room", "new-room-pass");
    const member = makeUser("mover");
    setUserCurrentRoom(member.id, from.room.id);

    const oldHabit = createHabit(from.room.id, "Old habit", "binary", 10);
    upsertHabitLog(member.id, oldHabit.id, 1, "2026-08-01");

    setUserCurrentRoom(member.id, to.room.id);

    // Nothing is deleted on a voluntary leave (PRD §1): the history stays, it
    // just stops counting toward the room they left behind.
    assert.equal(getUserTotalPoints(member.id, from.room.id), 10);
    assert.equal(getUserTotalPoints(member.id, to.room.id), 0);
    assert.equal(getUserTotalPoints(member.id), 10);
  });
});

describe("room-scoped leaderboard", () => {
  it("ranks only the room's members, counting only points earned in it", () => {
    const home = makeRoom("Home room", "home-room-pass");
    const other = makeRoom("Other room", "other-room-pass");

    const homeHabit = createHabit(home.room.id, "Home habit", "binary", 10);
    const otherHabit = createHabit(other.room.id, "Other habit", "binary", 50);

    const stayer = makeUser("stayer");
    setUserCurrentRoom(stayer.id, home.room.id);
    upsertHabitLog(stayer.id, homeHabit.id, 1, "2026-08-01");

    const newcomer = makeUser("newcomer");
    setUserCurrentRoom(newcomer.id, other.room.id);
    upsertHabitLog(newcomer.id, otherHabit.id, 1, "2026-08-01");
    setUserCurrentRoom(newcomer.id, home.room.id);

    const rows = getLeaderboard(home.room.id);
    const nicknames = rows.map((r) => r.nickname);
    assert.ok(nicknames.includes("stayer"));
    assert.ok(nicknames.includes("newcomer"));
    assert.ok(!nicknames.includes("mover"), "a member of another room must not appear");

    // The newcomer's 50 points came from the other room and do not follow them.
    assert.equal(rows.find((r) => r.nickname === "newcomer")?.total, 0);
    assert.equal(rows.find((r) => r.nickname === "stayer")?.total, 10);

    // The CSV export ranks identically, just with the Telegram identity fields.
    const exported = getExportRows(home.room.id);
    assert.deepEqual(exported.map((r) => r.user_id), rows.map((r) => r.user_id));
  });
});

describe("room admins", () => {
  it("promotes and demotes participants of a room", () => {
    const { room, owner } = makeRoom("Governance room", "governance-room-pass");
    const participant = makeUser();
    setUserCurrentRoom(participant.id, room.id);

    addRoomAdmin(room.id, participant.id);
    assert.equal(isRoomAdmin(participant.id, room.id), true);
    assert.equal(countRoomAdmins(room.id), 2);
    assert.deepEqual(listRoomAdminUserIds(room.id), [owner.id, participant.id]);

    // Any co-admin may demote any other, the original owner included (PRD §3a).
    removeRoomAdmin(room.id, owner.id);
    assert.equal(isRoomAdmin(owner.id, room.id), false);
    assert.equal(countRoomAdmins(room.id), 1);
    // owner_user_id is historical record-keeping only — demotion doesn't rewrite it.
    assert.equal(getRoomById(room.id)?.owner_user_id, owner.id);
  });

  it("is idempotent on both promote and demote", () => {
    const { room } = makeRoom("Idempotent room", "idempotent-room-pass");
    const participant = makeUser();

    addRoomAdmin(room.id, participant.id);
    addRoomAdmin(room.id, participant.id);
    assert.equal(countRoomAdmins(room.id), 2);

    removeRoomAdmin(room.id, participant.id);
    removeRoomAdmin(room.id, participant.id);
    assert.equal(countRoomAdmins(room.id), 1);
  });

  it("strips co-admin status when the user leaves for another room", () => {
    const from = makeRoom("Source room", "source-room-pass");
    const to = makeRoom("Destination room", "destination-room-pass");
    const coAdmin = makeUser();
    setUserCurrentRoom(coAdmin.id, from.room.id);
    addRoomAdmin(from.room.id, coAdmin.id);

    setUserCurrentRoom(coAdmin.id, to.room.id);

    // Co-admin status does not transfer between rooms (PRD §3a): they arrive as
    // a plain participant and are no longer an admin of the room they left.
    assert.equal(isRoomAdmin(coAdmin.id, from.room.id), false);
    assert.equal(isRoomAdmin(coAdmin.id, to.room.id), false);
  });

  it("cannot be granted to the same user twice in one room", () => {
    const { room, owner } = makeRoom("Race room", "race-room-pass");

    // The composite primary key is the guard behind last-admin protection's
    // race condition (PRD §3a) — duplicate rows can never inflate the count.
    assert.throws(
      () =>
        db
          .prepare("INSERT INTO room_admins (room_id, user_id) VALUES (?, ?)")
          .run(room.id, owner.id),
      /UNIQUE constraint failed/
    );
  });
});

describe("membership", () => {
  it("scopes nickname uniqueness to a room", () => {
    const a = makeRoom("Nickname room A", "nickname-a-pass");
    const b = makeRoom("Nickname room B", "nickname-b-pass");

    const first = createUser(nextTelegramId++, "Ali");
    setUserCurrentRoom(first.id, a.room.id);

    // The same nickname is free in another room, taken in this one (PRD §3a).
    assert.equal(isNicknameTaken("Ali", { roomId: b.room.id }), false);
    assert.equal(isNicknameTaken("ali", { roomId: a.room.id }), true);
    assert.equal(
      isNicknameTaken("Ali", { roomId: a.room.id, excludeTelegramId: first.telegram_id }),
      false
    );
  });

  it("pauses reminders while a user is between rooms", () => {
    const { room } = makeRoom("Reminder room", "reminder-room-pass");
    const member = makeUser();
    setUserCurrentRoom(member.id, room.id);

    assert.ok(getUsersWithRemindersEnabled().some((u) => u.id === member.id));

    setUserCurrentRoom(member.id, null);

    // Nothing to log against, so no reminder DM (PRD §3a).
    assert.ok(!getUsersWithRemindersEnabled().some((u) => u.id === member.id));
    assert.equal(getUserByTelegramId(member.telegram_id)?.current_room_id, null);
  });

  it("defaults a new user to participant with no room", () => {
    const user = makeUser();
    assert.equal(user.role, "participant");
    assert.equal(user.current_room_id, null);

    const admin = createUser(nextTelegramId++, "room-founder", undefined, null, undefined, {
      role: "admin",
    });
    assert.equal(admin.role, "admin");
    assert.equal(admin.current_room_id, null);
  });
});

describe("demoteRoomAdmin", () => {
  it("demotes a co-admin but refuses to empty the room", () => {
    const { room, owner } = makeRoom("Demote room", "demote-room-pass");
    const coAdmin = makeUser();
    setUserCurrentRoom(coAdmin.id, room.id);
    addRoomAdmin(room.id, coAdmin.id);

    assert.deepEqual(demoteRoomAdmin(room.id, coAdmin.id), { demoted: true, lastAdmin: false });
    assert.equal(isRoomAdmin(coAdmin.id, room.id), false);

    // The owner is now the only admin left, so the room refuses to lose them —
    // promote someone else first (PRD §3a).
    assert.deepEqual(demoteRoomAdmin(room.id, owner.id), { demoted: false, lastAdmin: true });
    assert.equal(countRoomAdmins(room.id), 1);
  });

  it("reports a plain participant as neither demoted nor the last admin", () => {
    const { room } = makeRoom("Plain demote room", "plain-demote-pass");
    const member = makeUser();
    setUserCurrentRoom(member.id, room.id);

    assert.deepEqual(demoteRoomAdmin(room.id, member.id), { demoted: false, lastAdmin: false });
  });
});

describe("leaveCurrentRoom", () => {
  it("detaches membership and co-admin status while keeping the logs", () => {
    const { room, owner } = makeRoom("Leave room", "leave-room-pass");
    const coAdmin = makeUser();
    setUserCurrentRoom(coAdmin.id, room.id);
    addRoomAdmin(room.id, coAdmin.id);
    const habit = createHabit(room.id, "Leave habit", "quantity", 3);
    upsertHabitLog(coAdmin.id, habit.id, 4, "2026-09-10");

    const result = leaveCurrentRoom(coAdmin.id);
    assert.deepEqual(result, { left: true, lastAdmin: false, roomId: room.id });
    assert.equal(getUserByTelegramId(coAdmin.telegram_id)?.current_room_id, null);
    assert.equal(isRoomAdmin(coAdmin.id, room.id), false);
    // A voluntary leave deletes nothing (PRD §1).
    assert.equal(getUserTotalPoints(coAdmin.id, room.id), 12);

    assert.deepEqual(leaveCurrentRoom(owner.id), {
      left: false,
      lastAdmin: true,
      roomId: room.id,
    });
  });

  it("reports no room for someone already between rooms", () => {
    const stray = makeUser();
    assert.deepEqual(leaveCurrentRoom(stray.id), { left: false, lastAdmin: false, roomId: null });
  });
});

describe("kickUserFromRoom", () => {
  it("deletes this room's logs only, and never the room's last admin", () => {
    const first = makeRoom("Kick room", "kick-room-pass");
    const second = makeRoom("Other kick room", "other-kick-room-pass");
    const wanderer = makeUser();

    const firstHabit = createHabit(first.room.id, "First habit", "quantity", 2);
    setUserCurrentRoom(wanderer.id, first.room.id);
    upsertHabitLog(wanderer.id, firstHabit.id, 5, "2026-09-10");

    const secondHabit = createHabit(second.room.id, "Second habit", "quantity", 3);
    setUserCurrentRoom(wanderer.id, second.room.id);
    upsertHabitLog(wanderer.id, secondHabit.id, 5, "2026-09-10");

    const result = kickUserFromRoom(wanderer.id, second.room.id);
    assert.equal(result.kicked, true);
    assert.equal(result.habitLogsDeleted, 1);
    assert.equal(getUserByTelegramId(wanderer.telegram_id)?.current_room_id, null);
    assert.equal(getUserTotalPoints(wanderer.id, second.room.id), 0);
    // The room they were kicked from is the only one that loses anything.
    assert.equal(getUserTotalPoints(wanderer.id, first.room.id), 10);

    assert.deepEqual(kickUserFromRoom(second.owner.id, second.room.id), {
      kicked: false,
      lastAdmin: true,
      habitLogsDeleted: 0,
      wasRoomAdmin: true,
    });
  });

  it("does nothing to someone who is not in that room", () => {
    const { room } = makeRoom("Bystander room", "bystander-room-pass");
    const outsider = makeUser();

    assert.deepEqual(kickUserFromRoom(outsider.id, room.id), {
      kicked: false,
      lastAdmin: false,
      habitLogsDeleted: 0,
      wasRoomAdmin: false,
    });
  });
});

/** Everything a room owns, so a delete has something real to cascade through. */
function furnishRoom(name: string, password: string) {
  const { room, owner } = makeRoom(name, password);
  const habit = createHabit(room.id, `${name} habit`, "quantity", 2);
  upsertHabitLog(owner.id, habit.id, 5, "2026-09-01");
  const personal = createPersonalHabit(owner.id, room.id, `${name} personal`, "binary", null);
  upsertPersonalHabitLog(personal.id, 1, "2026-09-01");
  return { room, owner, habit, personal };
}

function countIn(table: string, roomId: number): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE room_id = ?`)
    .get(roomId) as { n: number };
  return row.n;
}

describe("deleteRoom", () => {
  it("takes every table that hangs off the room with it", () => {
    const { room } = furnishRoom("Doomed room", "doomed-room-pass");

    const result = deleteRoom(room.id);

    assert.equal(result.deleted, true);
    assert.equal(getRoomById(room.id), undefined);
    // The cascade is the only thing doing this work — nothing above deletes a
    // child row by hand — so it is worth asserting table by table. habit_logs
    // in particular points at habits with no ON DELETE clause of its own, and
    // survives this only because SQLite checks immediate foreign keys at the
    // end of the statement rather than row by row.
    for (const table of [
      "room_admins",
      "habits",
      "habit_logs",
      "personal_habits",
      "personal_habit_logs",
    ]) {
      assert.equal(countIn(table, room.id), 0, `${table} should be empty`);
    }
  });

  it("leaves the members it had without a room, and without a stale join date", () => {
    const { room, owner } = furnishRoom("Emptied room", "emptied-room-pass");
    const other = makeUser();
    setUserCurrentRoom(other.id, room.id);

    const result = deleteRoom(room.id);

    assert.equal(result.membersDetached, 2);
    for (const user of [owner, other]) {
      const after = getUserByTelegramId(user.telegram_id)!;
      assert.equal(after.current_room_id, null);
      // current_room_id is ON DELETE SET NULL; room_joined_at is not, and a
      // join date with no room behind it would outlive the room forever.
      assert.equal(after.room_joined_at, null);
    }
  });

  it("touches nothing belonging to another room", () => {
    const doomed = furnishRoom("Neighbour A", "neighbour-a-pass");
    const survivor = furnishRoom("Neighbour B", "neighbour-b-pass");

    deleteRoom(doomed.room.id);

    assert.equal(getRoomById(survivor.room.id)?.id, survivor.room.id);
    assert.equal(countIn("habits", survivor.room.id), 1);
    assert.equal(countIn("habit_logs", survivor.room.id), 1);
    assert.equal(countIn("personal_habits", survivor.room.id), 1);
    assert.equal(
      getUserByTelegramId(survivor.owner.telegram_id)?.current_room_id,
      survivor.room.id
    );
  });

  it("frees the password again and shrugs at an id that never existed", () => {
    const { room } = makeRoom("Reusable pass room", "reusable-pass-room");

    deleteRoom(room.id);

    assert.equal(getRoomByPassword("reusable-pass-room"), undefined);
    const reborn = makeRoom("Second life", "reusable-pass-room");
    assert.equal(getRoomByPassword("reusable-pass-room")?.id, reborn.room.id);

    assert.deepEqual(deleteRoom(999_999), { deleted: false, membersDetached: 0 });
  });
});

describe("registerUser", () => {
  it("writes a second registration onto the same row, keeping the account", () => {
    const { room, owner } = makeRoom("Re-reg room", "re-reg-room-pass");
    const returning = makeUser("Before");
    setUserCurrentRoom(returning.id, room.id);
    updateUserProfile(returning.telegram_id, { realName: "Before Name" });
    leaveCurrentRoom(returning.id);

    const after = registerUser(
      returning.telegram_id,
      "After",
      { telegramUsername: null, telegramFirstName: null, telegramLastName: null },
      "After Name",
      {
        reminderEnabled: true,
        reminderTime: "05:00",
        fastingReminderEnabled: false,
        fastingReminderTime: "20:00",
      },
      { role: "admin", currentRoomId: room.id }
    );

    // Same account, new answers — their history hangs off this id.
    assert.equal(after.id, returning.id);
    assert.equal(after.nickname, "After");
    assert.equal(after.real_name, "After Name");
    assert.equal(after.role, "admin");
    assert.equal(after.reminder_time, "05:00");
    assert.equal(after.current_room_id, room.id);
    assert.notEqual(after.room_joined_at, null);
    assert.equal(getParticipantCount(room.id), 2);
    assert.equal(owner.id !== after.id, true);
  });

  it("refuses to move someone who is still in a room", () => {
    const { room, owner } = makeRoom("Immovable room", "immovable-room-pass");
    const elsewhere = makeRoom("Elsewhere", "elsewhere-reg-pass");
    addRoomAdmin(room.id, makeUser().id);

    // Registration is not a way to change rooms: doing it here would strip
    // their co-admin row and personal habits with no confirmation anywhere.
    assert.throws(
      () =>
        registerUser(
          owner.telegram_id,
          "Sneaky",
          { telegramUsername: null, telegramFirstName: null, telegramLastName: null },
          null,
          {
            reminderEnabled: false,
            reminderTime: "20:00",
            fastingReminderEnabled: false,
            fastingReminderTime: "20:00",
          },
          { role: "participant", currentRoomId: elsewhere.room.id }
        ),
      /already in room/
    );
    assert.equal(getUserByTelegramId(owner.telegram_id)?.current_room_id, room.id);
    assert.equal(isRoomAdmin(owner.id, room.id), true);
  });
});

describe("switchRoomWithKick", () => {
  it("moves a plain member and deletes what they earned in the room they left", () => {
    const from = makeRoom("Leaving room", "leaving-room-pass");
    const to = makeRoom("Arriving room", "arriving-room-pass");
    const elsewhere = makeRoom("Third room", "third-room-pass");
    const mover = makeUser("mover-switch");

    const oldHabit = createHabit(from.room.id, "Old habit", "quantity", 2);
    const otherHabit = createHabit(elsewhere.room.id, "Other habit", "quantity", 3);
    setUserCurrentRoom(mover.id, elsewhere.room.id);
    upsertHabitLog(mover.id, otherHabit.id, 5, "2026-09-01");
    setUserCurrentRoom(mover.id, from.room.id);
    upsertHabitLog(mover.id, oldHabit.id, 5, "2026-09-01");
    createPersonalHabit(mover.id, from.room.id, "Old personal", "binary", null);

    const result = switchRoomWithKick(mover.id, to.room.id);

    assert.equal(result.switched, true);
    assert.equal(result.oldRoomId, from.room.id);
    assert.equal(result.oldRoomDeleted, false);
    assert.equal(result.habitLogsDeleted, 1);
    assert.equal(getUserByTelegramId(mover.telegram_id)?.current_room_id, to.room.id);
    // A switch is a kick, not a leave: nothing of theirs is left ranking in the
    // room they walked out of.
    assert.equal(getUserTotalPoints(mover.id, from.room.id), 0);
    assert.equal(listPersonalHabits(mover.id, from.room.id).length, 0);
    // A room they passed through earlier is none of this switch's business.
    assert.equal(getUserTotalPoints(mover.id, elsewhere.room.id), 15);
  });

  it("drops co-admin status in the room being left", () => {
    const from = makeRoom("Co-admin room", "co-admin-room-pass");
    const to = makeRoom("Somewhere else", "somewhere-else-pass");
    const coAdmin = makeUser("co-admin-switch");
    setUserCurrentRoom(coAdmin.id, from.room.id);
    addRoomAdmin(from.room.id, coAdmin.id);

    assert.equal(switchRoomWithKick(coAdmin.id, to.room.id).switched, true);

    // Co-admin status never transfers and never survives a move (PRD §3a).
    assert.equal(isRoomAdmin(coAdmin.id, from.room.id), false);
    assert.equal(isRoomAdmin(coAdmin.id, to.room.id), false);
    assert.equal(countRoomAdmins(from.room.id), 1);
  });

  it("refuses the last admin of a room that still has people in it, writing nothing", () => {
    const from = makeRoom("Stranded room", "stranded-room-pass");
    const to = makeRoom("Tempting room", "tempting-room-pass");
    const member = makeUser("left-behind");
    setUserCurrentRoom(member.id, from.room.id);
    const habit = createHabit(from.room.id, "Kept habit", "quantity", 2);
    upsertHabitLog(from.owner.id, habit.id, 5, "2026-09-01");

    const result = switchRoomWithKick(from.owner.id, to.room.id);

    assert.equal(result.lastAdmin, true);
    assert.equal(result.switched, false);
    assert.equal(result.habitLogsDeleted, 0);
    assert.equal(getUserByTelegramId(from.owner.telegram_id)?.current_room_id, from.room.id);
    assert.equal(getUserTotalPoints(from.owner.id, from.room.id), 10);
    assert.equal(isRoomAdmin(from.owner.id, from.room.id), true);
    assert.equal(isLastAdminWithMembers(from.owner.id, from.room.id), true);

    // ...and it goes through the moment someone else can run the room.
    addRoomAdmin(from.room.id, member.id);
    assert.equal(isLastAdminWithMembers(from.owner.id, from.room.id), false);
    assert.equal(switchRoomWithKick(from.owner.id, to.room.id).switched, true);
    assert.equal(getRoomById(from.room.id)?.id, from.room.id);
  });

  it("deletes the old room when its only member was an admin", () => {
    const from = furnishRoom("Last one out", "last-one-out-pass");
    const to = makeRoom("Fresh start", "fresh-start-pass");

    const result = switchRoomWithKick(from.owner.id, to.room.id);

    assert.equal(result.switched, true);
    assert.equal(result.oldRoomDeleted, true);
    assert.equal(getRoomById(from.room.id), undefined);
    assert.equal(getUserByTelegramId(from.owner.telegram_id)?.current_room_id, to.room.id);
    assert.equal(countIn("habits", from.room.id), 0);
  });

  it("leaves an empty room standing when its last member did not run it", () => {
    const from = makeRoom("Orphan room", "orphan-room-pass");
    const to = makeRoom("Anywhere else", "anywhere-else-pass");
    // Contrived on purpose: only a direct edit gets a room to a sole member who
    // is not its admin, since leaving is refused for the last admin.
    removeRoomAdmin(from.room.id, from.owner.id);

    const result = switchRoomWithKick(from.owner.id, to.room.id);

    assert.equal(result.switched, true);
    // We only ever delete a room on behalf of someone who was running it.
    assert.equal(result.oldRoomDeleted, false);
    assert.equal(getRoomById(from.room.id)?.id, from.room.id);
  });

  it("carries the whole person across: nickname, real name and reminders", () => {
    const from = makeRoom("Departure", "departure-pass");
    const to = makeRoom("Arrival", "arrival-pass");
    const mover = makeUser("Unchanged");
    setUserCurrentRoom(mover.id, from.room.id);
    updateUserProfile(mover.telegram_id, {
      realName: "Real Person",
      reminderEnabled: true,
      reminderTime: "07:15",
      fastingReminderEnabled: true,
      fastingReminderTime: "21:45",
    });

    switchRoomWithKick(mover.id, to.room.id);

    const after = getUserByTelegramId(mover.telegram_id)!;
    assert.equal(after.nickname, "Unchanged");
    assert.equal(after.real_name, "Real Person");
    assert.equal(after.reminder_enabled, 1);
    assert.equal(after.reminder_time, "07:15");
    assert.equal(after.fasting_reminder_enabled, 1);
    assert.equal(after.fasting_reminder_time, "21:45");
    assert.notEqual(after.room_joined_at, null);
  });

  it("moves someone who is between rooms without deleting anything", () => {
    const to = makeRoom("Way back in", "way-back-in-pass");
    const roomless = makeUser("roomless-switch");

    const result = switchRoomWithKick(roomless.id, to.room.id);

    assert.equal(result.switched, true);
    assert.equal(result.oldRoomId, null);
    assert.equal(result.oldRoomDeleted, false);
    assert.equal(result.habitLogsDeleted, 0);
    assert.equal(getUserByTelegramId(roomless.telegram_id)?.current_room_id, to.room.id);
  });

  it("reports a room that is already gone, and a room they are already in", () => {
    const { room, owner } = makeRoom("Standing still", "standing-still-pass");

    const missing = switchRoomWithKick(owner.id, 999_999);
    assert.equal(missing.targetMissing, true);
    assert.equal(missing.switched, false);
    assert.equal(getUserByTelegramId(owner.telegram_id)?.current_room_id, room.id);

    const joinedAt = getUserByTelegramId(owner.telegram_id)!.room_joined_at;
    const again = switchRoomWithKick(owner.id, room.id);
    assert.equal(again.alreadyThere, true);
    assert.equal(again.switched, false);
    // A no-op must not read as a fresh join to the weekly view.
    assert.equal(getUserByTelegramId(owner.telegram_id)!.room_joined_at, joinedAt);
  });
});

describe("regenerateRoomPassword", () => {
  it("swaps the password without touching membership", () => {
    const { room, owner } = makeRoom("Regen repo room", "regen-repo-pass");

    const updated = regenerateRoomPassword(room.id);
    assert.notEqual(updated.password, "regen-repo-pass");
    assert.equal(getRoomByPassword("regen-repo-pass"), undefined);
    assert.equal(getRoomByPassword(updated.password)?.id, room.id);
    assert.equal(getUserByTelegramId(owner.telegram_id)?.current_room_id, room.id);
  });
});
