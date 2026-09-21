import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Request, Response } from "express";

process.env.BOT_TOKEN ??= "progress-history-route-test";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH ??= ":memory:";

const {
  createHabit,
  createPersonalHabit,
  createRoom,
  createUser,
  setUserCurrentRoom,
  updateHabit,
  updateUserProfile,
  upsertHabitLog,
  upsertPersonalHabitLog,
} = await import("../../db/repository.js");
const { db } = await import("../../db/client.js");
const { getDayKeyInTimezone } = await import("../../utils/challenge.js");
const { monthBounds, addCalendarDays, parseDateKey, formatDateParts } = await import(
  "../../utils/dates.js"
);
const { historyHabitsRoute, historyMonthRoute } = await import("./progressHistory.js");

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

function callHabits(telegramId: number): { status: number; body: any } {
  const result = capture();
  historyHabitsRoute({ telegramId } as unknown as Request, result.res);
  return { status: result.status(), body: result.body() };
}

function callMonth(
  telegramId: number,
  query: { kind?: string; habitId?: string | number; month?: string }
): { status: number; body: any } {
  const result = capture();
  historyMonthRoute(
    {
      telegramId,
      query: {
        ...(query.kind !== undefined ? { kind: query.kind } : {}),
        ...(query.habitId !== undefined ? { habitId: String(query.habitId) } : {}),
        ...(query.month !== undefined ? { month: query.month } : {}),
      },
    } as unknown as Request,
    result.res
  );
  return { status: result.status(), body: result.body() };
}

function setRoomJoinedAt(telegramId: number, sqliteUtc: string): void {
  db.prepare("UPDATE users SET room_joined_at = ? WHERE telegram_id = ?").run(sqliteUtc, telegramId);
}

function setHabitCreatedAt(habitId: number, sqliteUtc: string): void {
  db.prepare("UPDATE habits SET created_at = ? WHERE id = ?").run(sqliteUtc, habitId);
}

function setPersonalHabitCreatedAt(personalHabitId: number, sqliteUtc: string): void {
  db.prepare("UPDATE personal_habits SET created_at = ? WHERE id = ?").run(
    sqliteUtc,
    personalHabitId
  );
}

let nextTelegramId = 810000001;

function makeRoom() {
  const owner = createUser(nextTelegramId++, `history-owner-${nextTelegramId}`);
  const room = createRoom(`History room ${nextTelegramId}`, `history-pass-${nextTelegramId}`, owner.id);
  setUserCurrentRoom(owner.id, room.id);
  return room;
}

/** A member backdated well out of the way, so nothing narrows a month's lowerBound. */
function makeBackfillableMember(roomId: number): number {
  const telegramId = nextTelegramId++;
  const user = createUser(telegramId, `history-member-${telegramId}`);
  setUserCurrentRoom(user.id, roomId);
  setRoomJoinedAt(telegramId, "2000-01-01 00:00:00");
  return telegramId;
}

// A fixed month safely in the past for any real run date, so `future` is
// deterministically false throughout it and the grid's shape never depends on
// which real day the suite executes on. March 2024: 1st is a Friday and the
// 31st is a Sunday, so the grid has leading padding (Feb 26-29) and none
// trailing (ends exactly on the 31st) — good coverage of both padding shapes
// in one fixture.
const MARCH_2024 = "2024-03";
const { monthStart: MARCH_START, monthEnd: MARCH_END } = monthBounds(2024, 3);
const GRID_START = "2024-02-26";

describe("GET /api/progress/history/habits", () => {
  it("lists active and inactive room habits, plus only the caller's own personal habits", () => {
    const room = makeRoom();
    const telegramId = makeBackfillableMember(room.id);
    const other = makeBackfillableMember(room.id);

    const active = createHabit(room.id, "Active room habit", 5);
    const inactive = createHabit(room.id, "Retired room habit", 5);
    updateHabit(inactive.id, { isActive: false });
    const mine = createPersonalHabit(nextTelegramIdToUserId(telegramId), room.id, "My habit", null);
    createPersonalHabit(nextTelegramIdToUserId(other), room.id, "Their habit", null);

    const { status, body } = callHabits(telegramId);
    assert.equal(status, 200);

    const byName = new Map<string, any>(body.map((h: any): [string, any] => [h.name, h]));
    assert.deepEqual(byName.get("Active room habit"), {
      id: active.id,
      kind: "room",
      name: "Active room habit",
      category: null,
      period: "daily",
      isActive: true,
    });
    assert.deepEqual(byName.get("Retired room habit"), {
      id: inactive.id,
      kind: "room",
      name: "Retired room habit",
      category: null,
      period: "daily",
      isActive: false,
    });
    assert.deepEqual(byName.get("My habit"), {
      id: mine.id,
      kind: "personal",
      name: "My habit",
      category: null,
      period: "daily",
      isActive: true,
    });
    // Privacy: another member's personal habit never appears.
    assert.equal(byName.has("Their habit"), false);
  });

  it("is empty for a caller between rooms", () => {
    const telegramId = nextTelegramId++;
    createUser(telegramId, `roomless-${telegramId}`);
    const { status, body } = callHabits(telegramId);
    assert.equal(status, 200);
    assert.deepEqual(body, []);
  });
});

function nextTelegramIdToUserId(telegramId: number): number {
  const row = db.prepare("SELECT id FROM users WHERE telegram_id = ?").get(telegramId) as {
    id: number;
  };
  return row.id;
}

describe("GET /api/progress/history — daily room habit", () => {
  it("draws a full calendar-month grid with leading/trailing padding, logged state and a monthly summary", () => {
    const room = makeRoom();
    const telegramId = makeBackfillableMember(room.id);
    const habit = createHabit(room.id, "March habit", 4);
    setHabitCreatedAt(habit.id, "2000-01-01 00:00:00");
    const userId = nextTelegramIdToUserId(telegramId);

    upsertHabitLog(userId, habit.id, 1, "2024-03-05");
    upsertHabitLog(userId, habit.id, 1, "2024-03-20");

    const { status, body } = callMonth(telegramId, {
      kind: "room",
      habitId: habit.id,
      month: MARCH_2024,
    });
    assert.equal(status, 200);
    assert.equal(body.month, MARCH_2024);
    assert.equal(body.monthStart, MARCH_START);
    assert.equal(body.monthEnd, MARCH_END);
    assert.deepEqual(body.habit, {
      id: habit.id,
      kind: "room",
      name: "March habit",
      category: null,
      period: "daily",
      isActive: true,
    });

    // 4 leading padding days (Feb 26-29) + 31 March days, none trailing.
    assert.equal(body.days.length, 35);
    assert.equal(body.days[0].date, GRID_START);
    assert.equal(body.days[3].date, "2024-02-29");
    assert.equal(body.days[3].outOfMonth, true);
    assert.equal(body.days[4].date, MARCH_START);
    assert.equal(body.days[4].outOfMonth, false);
    assert.equal(body.days[body.days.length - 1].date, MARCH_END);

    const byDate = new Map<string, any>(body.days.map((d: any): [string, any] => [d.date, d]));
    assert.equal(byDate.get("2024-03-05").logged, true);
    assert.equal(byDate.get("2024-03-20").logged, true);
    assert.equal(byDate.get("2024-03-06").logged, false);
    // Every March day is applicable (habit and membership long predate it),
    // and none of it is "future" — the fixture month is safely in the past.
    for (const day of body.days) {
      if (day.outOfMonth) continue;
      assert.equal(day.future, false, day.date);
      assert.equal(day.locked, false, day.date);
    }

    assert.equal(body.completedCount, 2);
    assert.equal(body.applicableDays, 31);
    assert.equal(body.totalPoints, 8);
    assert.equal(body.hasData, true);
  });

  it("reports no data for a month with nothing logged", () => {
    const room = makeRoom();
    const telegramId = makeBackfillableMember(room.id);
    const habit = createHabit(room.id, "Untouched", 5);
    setHabitCreatedAt(habit.id, "2000-01-01 00:00:00");

    const { body } = callMonth(telegramId, { kind: "room", habitId: habit.id, month: MARCH_2024 });
    assert.equal(body.hasData, false);
    assert.equal(body.completedCount, 0);
    assert.equal(body.totalPoints, 0);
  });

  it("locks days before the caller joined the room or the habit was created", () => {
    const room = makeRoom();
    const telegramId = nextTelegramId++;
    const user = createUser(telegramId, `history-joiner-${telegramId}`);
    setUserCurrentRoom(user.id, room.id);
    setRoomJoinedAt(telegramId, "2024-03-10 00:00:00"); // noon-ish HK on the 10th
    const habit = createHabit(room.id, "Joined mid-month", 5);
    setHabitCreatedAt(habit.id, "2024-03-15 00:00:00");

    const { body } = callMonth(telegramId, { kind: "room", habitId: habit.id, month: MARCH_2024 });
    const byDate = new Map<string, any>(body.days.map((d: any): [string, any] => [d.date, d]));
    // Before the later of join day (10th) and habit creation (15th): locked.
    assert.equal(byDate.get("2024-03-09").locked, true);
    assert.equal(byDate.get("2024-03-14").locked, true);
    assert.equal(byDate.get("2024-03-15").locked, false);
    assert.equal(byDate.get("2024-03-20").locked, false);
    // applicableDays: the 15th through the 31st, inclusive.
    assert.equal(body.applicableDays, 17);
    // Month-nav floor is the room-join month, not the (later) habit-created
    // one — switching habits mid-browse must never move it.
    assert.equal(body.earliestMonth, "2024-03");
  });

  it("flags a day after the caller's own today as future, and today itself as not future", () => {
    const room = makeRoom();
    const telegramId = makeBackfillableMember(room.id);
    const habit = createHabit(room.id, "Current month habit", 5);
    setHabitCreatedAt(habit.id, "2000-01-01 00:00:00");

    const todayKey = getDayKeyInTimezone();
    const [year, month] = todayKey.split("-").map(Number);
    const monthParam = `${year}-${String(month).padStart(2, "0")}`;

    const { body } = callMonth(telegramId, { kind: "room", habitId: habit.id, month: monthParam });
    const byDate = new Map<string, any>(body.days.map((d: any): [string, any] => [d.date, d]));
    assert.equal(byDate.get(todayKey).future, false);

    const tomorrow = formatDateParts(addCalendarDays(parseDateKey(todayKey), 1));
    const tomorrowRow = byDate.get(tomorrow);
    // Only assert when tomorrow is still inside the same grid — a run on the
    // last day of a month would otherwise push it into next month's grid,
    // which this response does not cover.
    if (tomorrowRow) assert.equal(tomorrowRow.future, true);
  });
});

describe("GET /api/progress/history — weekly room habit", () => {
  it("returns one badge per week, counting every marked day of that week", () => {
    const room = makeRoom();
    const telegramId = makeBackfillableMember(room.id);
    const habit = createHabit(room.id, "Weekly march habit", 20, null, "weekly");
    setHabitCreatedAt(habit.id, "2000-01-01 00:00:00");
    const userId = nextTelegramIdToUserId(telegramId);

    // Week of 2024-03-11..17: marked twice (only one carries points, but both count).
    upsertHabitLog(userId, habit.id, 1, "2024-03-11");
    upsertHabitLog(userId, habit.id, 1, "2024-03-13");
    // Week of 2024-03-18..24: marked once.
    upsertHabitLog(userId, habit.id, 1, "2024-03-20");

    const { status, body } = callMonth(telegramId, {
      kind: "room",
      habitId: habit.id,
      month: MARCH_2024,
    });
    assert.equal(status, 200);
    assert.equal(body.period, "weekly");
    assert.equal(body.days, undefined);

    const byWeekStart = new Map<string, any>(body.weeks.map((w: any): [string, any] => [w.weekStart, w]));
    assert.deepEqual(byWeekStart.get("2024-03-11"), {
      weekStart: "2024-03-11",
      weekEnd: "2024-03-17",
      count: 2,
      met: true,
    });
    assert.deepEqual(byWeekStart.get("2024-03-18"), {
      weekStart: "2024-03-18",
      weekEnd: "2024-03-24",
      count: 1,
      met: true,
    });
    // An untouched week in the grid is still present, just unmet.
    assert.deepEqual(byWeekStart.get("2024-03-25"), {
      weekStart: "2024-03-25",
      weekEnd: "2024-03-31",
      count: 0,
      met: false,
    });

    assert.equal(body.hasData, true);
    // The flat weight banked once per met week: 20 for the 11th's week (the
    // 13th's mark is real but worth nothing, the week already being banked)
    // plus 20 for the 20th's week.
    assert.equal(body.totalPoints, 40);
  });

  it("omits a week that began before the caller joined the room entirely, rather than showing it partial", () => {
    const room = makeRoom();
    const telegramId = nextTelegramId++;
    const user = createUser(telegramId, `history-weekly-joiner-${telegramId}`);
    setUserCurrentRoom(user.id, room.id);
    // Joined Wednesday the 13th, mid-week (week of 2024-03-11..17).
    setRoomJoinedAt(telegramId, "2024-03-13 00:00:00");
    const habit = createHabit(room.id, "Weekly, joined mid-week", 10, null, "weekly");
    setHabitCreatedAt(habit.id, "2000-01-01 00:00:00");

    const { body } = callMonth(telegramId, { kind: "room", habitId: habit.id, month: MARCH_2024 });
    const weekStarts = body.weeks.map((w: any) => w.weekStart);
    // The week of 2024-02-26 (grid's leading week) and 2024-03-04 both began
    // before the join day; the join week itself (2024-03-11) began before the
    // 13th too, so it is omitted as well — only weeks that started on or after
    // the join day remain.
    assert.ok(!weekStarts.includes("2024-02-26"));
    assert.ok(!weekStarts.includes("2024-03-04"));
    assert.ok(!weekStarts.includes("2024-03-11"));
    assert.ok(weekStarts.includes("2024-03-18"));
    assert.ok(weekStarts.includes("2024-03-25"));
  });
});

describe("GET /api/progress/history — personal habit", () => {
  it("draws the same daily grid shape, with no totalPoints field", () => {
    const room = makeRoom();
    const telegramId = makeBackfillableMember(room.id);
    const userId = nextTelegramIdToUserId(telegramId);
    const habit = createPersonalHabit(userId, room.id, "Personal march habit", null);
    setPersonalHabitCreatedAt(habit.id, "2000-01-01 00:00:00");
    upsertPersonalHabitLog(habit.id, 1, "2024-03-05");

    const { status, body } = callMonth(telegramId, {
      kind: "personal",
      habitId: habit.id,
      month: MARCH_2024,
    });
    assert.equal(status, 200);
    assert.equal(body.period, "daily");
    assert.equal("totalPoints" in body, false);
    assert.equal(body.hasData, true);
    const byDate = new Map<string, any>(body.days.map((d: any): [string, any] => [d.date, d]));
    assert.equal(byDate.get("2024-03-05").logged, true);
  });

  it("404s another member's personal habit exactly like one that does not exist", () => {
    const room = makeRoom();
    const mine = makeBackfillableMember(room.id);
    const theirs = makeBackfillableMember(room.id);
    const theirHabit = createPersonalHabit(
      nextTelegramIdToUserId(theirs),
      room.id,
      "Not yours",
      null
    );

    const { status, body } = callMonth(mine, {
      kind: "personal",
      habitId: theirHabit.id,
      month: MARCH_2024,
    });
    assert.equal(status, 404);
    assert.equal(body.error, "personal_habit_not_found");
  });
});

describe("GET /api/progress/history — validation and scoping", () => {
  it("rejects an unknown kind, a malformed habitId and a malformed month", () => {
    const room = makeRoom();
    const telegramId = makeBackfillableMember(room.id);
    const habit = createHabit(room.id, "Any habit", 5);

    assert.equal(
      callMonth(telegramId, { kind: "bogus", habitId: habit.id, month: MARCH_2024 }).body.error,
      "invalid_habit_ref"
    );
    assert.equal(
      callMonth(telegramId, { kind: "room", habitId: "abc", month: MARCH_2024 }).body.error,
      "invalid_habit_ref"
    );
    assert.equal(
      callMonth(telegramId, { kind: "room", habitId: habit.id, month: "2024-13" }).body.error,
      "invalid_month"
    );
    assert.equal(
      callMonth(telegramId, { kind: "room", habitId: habit.id, month: "not-a-month" }).body.error,
      "invalid_month"
    );
  });

  it("404s a habit id belonging to a different room", () => {
    const roomA = makeRoom();
    const roomB = makeRoom();
    const telegramId = makeBackfillableMember(roomA.id);
    const otherRoomHabit = createHabit(roomB.id, "Someone else's room", 5);

    const { status, body } = callMonth(telegramId, {
      kind: "room",
      habitId: otherRoomHabit.id,
      month: MARCH_2024,
    });
    assert.equal(status, 404);
    assert.equal(body.error, "habit_not_found");
  });

  it("400s with no_room for a caller between rooms", () => {
    const telegramId = nextTelegramId++;
    createUser(telegramId, `history-roomless-${telegramId}`);
    const { status, body } = callMonth(telegramId, { kind: "room", habitId: 1, month: MARCH_2024 });
    assert.equal(status, 400);
    assert.equal(body.error, "no_room");
  });

  it("still returns a deactivated habit's history, flagged inactive", () => {
    const room = makeRoom();
    const telegramId = makeBackfillableMember(room.id);
    const habit = createHabit(room.id, "Retired", 5);
    setHabitCreatedAt(habit.id, "2000-01-01 00:00:00");
    updateHabit(habit.id, { isActive: false });

    const { status, body } = callMonth(telegramId, {
      kind: "room",
      habitId: habit.id,
      month: MARCH_2024,
    });
    assert.equal(status, 200);
    assert.equal(body.habit.isActive, false);
  });

  it("resolves the month boundary the same way for every member regardless of their own timezone", () => {
    const room = makeRoom();
    const nearby = makeBackfillableMember(room.id);
    const farAway = makeBackfillableMember(room.id);
    updateUserProfile(farAway, { timezone: "Pacific/Midway" }); // UTC-11
    const habit = createHabit(room.id, "Shared month boundary", 5);
    setHabitCreatedAt(habit.id, "2000-01-01 00:00:00");

    const a = callMonth(nearby, { kind: "room", habitId: habit.id, month: MARCH_2024 }).body;
    const b = callMonth(farAway, { kind: "room", habitId: habit.id, month: MARCH_2024 }).body;
    assert.equal(a.monthStart, b.monthStart);
    assert.equal(a.monthEnd, b.monthEnd);
    assert.equal(a.monthStart, MARCH_START);
    assert.equal(a.monthEnd, MARCH_END);
  });
});
