import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.BOT_TOKEN ??= "rooms-test";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH ??= ":memory:";

const {
  addRoomAdmin,
  countRoomAdmins,
  createHabit,
  createRoom,
  createUser,
  getExportRows,
  getHabitById,
  getLeaderboard,
  getRoomById,
  getRoomByPassword,
  getUserByTelegramId,
  getUserTotalPoints,
  getUsersWithRemindersEnabled,
  isNicknameTaken,
  isRoomAdmin,
  listHabits,
  listRoomAdminUserIds,
  removeRoomAdmin,
  setRoomCategoriesEnabled,
  setUserCurrentRoom,
  updateHabit,
  updateRoomPassword,
  upsertHabitLog,
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
