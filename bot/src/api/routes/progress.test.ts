import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Request, Response } from "express";

process.env.BOT_TOKEN ??= "progress-route-test";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH ??= ":memory:";

const {
  createHabit,
  createRoom,
  createUser,
  deactivateHabit,
  setUserCurrentRoom,
  updateUserProfile,
  upsertHabitLog,
} = await import("../../db/repository.js");
const { db } = await import("../../db/client.js");
const { formatDateParts, getTodayInTimezone } = await import("../../utils/challenge.js");
const { addCalendarDays, weekdayOfDate } = await import("../../utils/dates.js");
const { progressRoute } = await import("./progress.js");
const { progressWeekRoute } = await import("./progressWeek.js");

/**
 * Two zones 25 hours apart: their local calendar dates differ at every instant,
 * which is what makes "today moves with the user's timezone" testable without
 * depending on when the suite happens to run.
 */
const FAR_EAST = "Pacific/Kiritimati"; // UTC+14
const FAR_WEST = "Pacific/Midway"; // UTC-11

function capture(): { res: Response; status: () => number; body: () => any } {
  let status = 200;
  let body: any;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(value: any) {
      body = value;
      return this;
    },
  } as unknown as Response;
  return { res, status: () => status, body: () => body };
}

function callProgress(telegramId: number) {
  const result = capture();
  progressRoute({ telegramId } as Request, result.res);
  return { status: result.status(), body: result.body() };
}

function callWeek(telegramId: number) {
  const result = capture();
  progressWeekRoute({ telegramId } as Request, result.res);
  return { status: result.status(), body: result.body() };
}

function todayIn(timezone: string): string {
  return formatDateParts(getTodayInTimezone(timezone));
}

let nextTelegramId = 910000001;
let nextRoomSuffix = 1;

function makeRoom() {
  const owner = createUser(nextTelegramId++, `progress-owner-${nextTelegramId}`);
  return createRoom(`Progress room ${nextRoomSuffix}`, `progress-pass-${nextRoomSuffix++}`, owner.id);
}

function makeMember(roomId: number, timezone: string | null = null) {
  const telegramId = nextTelegramId++;
  const user = createUser(telegramId, `progress-tester-${telegramId}`);
  setUserCurrentRoom(user.id, roomId);
  if (timezone) updateUserProfile(telegramId, { timezone });
  return { telegramId, userId: user.id };
}

describe("GET /api/progress — today's total", () => {
  it("sums only today's points, in this room, for this user", () => {
    const room = makeRoom();
    const other = makeRoom();
    const salawat = createHabit(room.id, "Salawat", "quantity", 2);
    const fajr = createHabit(room.id, "Fajr in jamaat", "binary", 15);
    const elsewhere = createHabit(other.id, "Someone else's habit", "binary", 99);

    const { telegramId, userId } = makeMember(room.id, "Asia/Hong_Kong");
    const today = todayIn("Asia/Hong_Kong");
    const yesterday = formatDateParts(
      addCalendarDays(getTodayInTimezone("Asia/Hong_Kong"), -1)
    );

    upsertHabitLog(userId, salawat.id, 10, today); // 10 * 2 = 20
    upsertHabitLog(userId, fajr.id, 1, today); // flat 15
    upsertHabitLog(userId, salawat.id, 100, yesterday); // yesterday: excluded
    upsertHabitLog(userId, elsewhere.id, 1, today); // another room: excluded

    const { body } = callProgress(telegramId);
    assert.equal(body.todayPoints, 35);
    assert.equal(body.todayDate, today);
    // All-time is still room-scoped but spans every day.
    assert.equal(body.totalPoints, 35 + 200);
  });

  it("counts points earned today against a habit deactivated since", () => {
    const room = makeRoom();
    const habit = createHabit(room.id, "Retired habit", "binary", 7);
    const { telegramId, userId } = makeMember(room.id, "Asia/Hong_Kong");

    upsertHabitLog(userId, habit.id, 1, todayIn("Asia/Hong_Kong"));
    deactivateHabit(habit.id);

    const { body } = callProgress(telegramId);
    // The points were earned while it was active; today's total is a record of
    // the day, not of the current habit list.
    assert.equal(body.todayPoints, 7);
    assert.equal(body.today.length, 0);
  });

  it("moves to the user's own day the moment their timezone changes", () => {
    const room = makeRoom();
    const habit = createHabit(room.id, "Timezone habit", "quantity", 3);
    const { telegramId, userId } = makeMember(room.id, FAR_EAST);

    const eastDay = todayIn(FAR_EAST);
    const westDay = todayIn(FAR_WEST);
    assert.notEqual(eastDay, westDay);

    upsertHabitLog(userId, habit.id, 4, eastDay); // 12 points, on the eastern day

    const east = callProgress(telegramId);
    assert.equal(east.body.todayDate, eastDay);
    assert.equal(east.body.todayPoints, 12);

    updateUserProfile(telegramId, { timezone: FAR_WEST });

    const west = callProgress(telegramId);
    assert.equal(west.body.todayDate, westDay);
    // Same rows, different "today" — nothing was recomputed or migrated.
    assert.equal(west.body.todayPoints, 0);
    assert.equal(west.body.totalPoints, 12);
  });

  it("falls back to the server timezone for a user who has never opened the app", () => {
    const room = makeRoom();
    const { telegramId } = makeMember(room.id, null);
    assert.equal(callProgress(telegramId).body.todayDate, todayIn("Asia/Hong_Kong"));
  });

  it("reports zero for a user between rooms, without inventing a day", () => {
    const room = makeRoom();
    const { telegramId, userId } = makeMember(room.id, "Asia/Hong_Kong");
    setUserCurrentRoom(userId, null);

    const { body } = callProgress(telegramId);
    assert.equal(body.room, null);
    assert.equal(body.todayPoints, 0);
    assert.equal(body.todayDate, todayIn("Asia/Hong_Kong"));
  });

  it("echoes the streak display preferences the screen renders from", () => {
    const room = makeRoom();
    const { telegramId } = makeMember(room.id);

    const defaults = callProgress(telegramId).body;
    assert.equal(defaults.streakDisplay, "weekly");
    assert.equal(defaults.weekStartDay, 1);

    updateUserProfile(telegramId, { streakDisplay: "current", weekStartDay: 0 });
    const switched = callProgress(telegramId).body;
    assert.equal(switched.streakDisplay, "current");
    assert.equal(switched.weekStartDay, 0);
  });
});

describe("GET /api/progress/week", () => {
  it("returns the seven days of the calendar week from the chosen start day", () => {
    const room = makeRoom();
    createHabit(room.id, "Weekly habit", "binary", 5);
    const { telegramId } = makeMember(room.id, "Asia/Hong_Kong");

    for (const weekStartDay of [0, 1, 6]) {
      updateUserProfile(telegramId, { weekStartDay });
      const { body } = callWeek(telegramId);

      assert.equal(body.days.length, 7);
      assert.equal(body.weekStart, body.days[0]);
      assert.equal(body.weekStartDay, weekStartDay);
      assert.equal(
        weekdayOfDate({
          year: Number(body.weekStart.slice(0, 4)),
          month: Number(body.weekStart.slice(5, 7)),
          day: Number(body.weekStart.slice(8, 10)),
        }),
        weekStartDay
      );
      // Consecutive days, with today among them.
      for (let i = 1; i < 7; i++) {
        assert.ok(body.days[i] > body.days[i - 1]);
      }
      assert.ok(body.days.includes(body.today));
      assert.equal(body.today, todayIn("Asia/Hong_Kong"));
    }
  });

  it("marks logged days lit, future days future, and nothing else", () => {
    const room = makeRoom();
    const habit = createHabit(room.id, "Tracked habit", "quantity", 4);
    const { telegramId, userId } = makeMember(room.id, "Asia/Hong_Kong");
    updateUserProfile(telegramId, { weekStartDay: 1 });

    const week = callWeek(telegramId).body;
    upsertHabitLog(userId, habit.id, 3, week.today);

    const { body } = callWeek(telegramId);
    assert.equal(body.habits.length, 1);
    const row = body.habits[0];
    assert.equal(row.habitId, habit.id);
    assert.equal(row.name, "Tracked habit");
    assert.equal(row.days.length, 7);

    for (const day of row.days) {
      assert.equal(day.logged, day.date === body.today);
      assert.equal(day.future, day.date > body.today);
      // Presence only — the view draws a flame, never a count.
      assert.deepEqual(Object.keys(day).sort(), ["date", "future", "locked", "logged"]);
    }
  });

  it("greys out the days of this week before the member joined", () => {
    const room = makeRoom();
    createHabit(room.id, "Joined midweek", "binary", 5);
    const { telegramId, userId } = makeMember(room.id, "Asia/Hong_Kong");
    updateUserProfile(telegramId, { weekStartDay: 1 });

    const week = callWeek(telegramId).body;
    const joinDay = week.days[2] as string;
    // room_joined_at is UTC text; 00:30 UTC on the join day is still that day
    // in Asia/Hong_Kong (UTC+8), which is the zone this member is in.
    db.prepare("UPDATE users SET room_joined_at = ? WHERE id = ?").run(
      `${joinDay} 00:30:00`,
      userId
    );

    const { body } = callWeek(telegramId);
    const row = body.habits[0];
    assert.deepEqual(
      row.days.map((d: { locked: boolean }) => d.locked),
      [true, true, false, false, false, false, false]
    );
  });

  it("hides deactivated habits and answers empty between rooms", () => {
    const room = makeRoom();
    const active = createHabit(room.id, "Still active", "binary", 5);
    const retired = createHabit(room.id, "Deactivated", "binary", 5);
    deactivateHabit(retired.id);
    const { telegramId, userId } = makeMember(room.id, "Asia/Hong_Kong");

    const inRoom = callWeek(telegramId).body;
    assert.deepEqual(
      inRoom.habits.map((h: { habitId: number }) => h.habitId),
      [active.id]
    );

    setUserCurrentRoom(userId, null);
    const roomless = callWeek(telegramId).body;
    assert.deepEqual(roomless.habits, []);
    // The week itself is still well-defined — there is just nothing in it.
    assert.equal(roomless.days.length, 7);
  });

  it("403s for an unregistered caller", () => {
    const { status, body } = callWeek(999000999);
    assert.equal(status, 403);
    assert.equal(body.error, "not_registered");
  });
});
