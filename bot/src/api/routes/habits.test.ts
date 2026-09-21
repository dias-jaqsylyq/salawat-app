import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Request, Response } from "express";

process.env.BOT_TOKEN ??= "habits-route-test";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH ??= ":memory:";

const {
  createHabit,
  createRoom,
  createUser,
  getHabitStreak,
  getUserByTelegramId,
  getUserTotalPoints,
  setUserCurrentRoom,
  updateHabit,
} = await import("../../db/repository.js");
const { deleteHabitLogRoute, habitLogWindowRoute, listHabitsRoute, logHabitRoute } = await import(
  "./habits.js"
);
const { getCurrentWeekBounds, getDayKeyInTimezone, shiftWeekStart } = await import(
  "../../utils/challenge.js"
);
const { db } = await import("../../db/client.js");

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

function callList(telegramId: number): { status: number; body: any } {
  const result = capture();
  listHabitsRoute({ telegramId } as unknown as Request, result.res);
  return { status: result.status(), body: result.body() };
}

function callLog(
  telegramId: number,
  habitId: number | string,
  body: unknown,
  date?: string
): { status: number; body: any } {
  const result = capture();
  logHabitRoute(
    {
      telegramId,
      params: { id: String(habitId) },
      body,
      query: date === undefined ? {} : { date },
    } as unknown as Request,
    result.res
  );
  return { status: result.status(), body: result.body() };
}

function callDeleteLog(
  telegramId: number,
  habitId: number | string,
  date?: string
): { status: number; body: any } {
  const result = capture();
  deleteHabitLogRoute(
    {
      telegramId,
      params: { id: String(habitId) },
      query: date === undefined ? {} : { date },
    } as unknown as Request,
    result.res
  );
  return { status: result.status(), body: result.body() };
}

function callLogWindow(telegramId: number, date?: string): { status: number; body: any } {
  const result = capture();
  habitLogWindowRoute(
    { telegramId, query: date === undefined ? {} : { date } } as unknown as Request,
    result.res
  );
  return { status: result.status(), body: result.body() };
}

/** These test users carry no timezone, so they fall back to TIMEZONE. */
const today = getDayKeyInTimezone();

let nextTelegramId = 700000001;

/** One shared room: every habit and every logger in this file belongs to it. */
const room = (() => {
  const owner = createUser(nextTelegramId++, "habits-room-owner");
  return createRoom("Habits room", "habits-room-pass", owner.id);
})();

function makeUser(): number {
  const telegramId = nextTelegramId++;
  const user = createUser(telegramId, `habits-tester-${telegramId}`);
  setUserCurrentRoom(user.id, room.id);
  return telegramId;
}

/**
 * A member whose room_joined_at is backdated well before this week — a fresh
 * makeUser() joins "now" like any other row, which is never earlier than
 * today, so it would itself narrow the backfill window to today alone. Tests
 * that need real headroom to backfill into use this instead.
 */
function makeBackfillableUser(): number {
  const telegramId = makeUser();
  db.prepare("UPDATE users SET room_joined_at = '2000-01-01 00:00:00' WHERE telegram_id = ?").run(
    telegramId
  );
  return telegramId;
}

function makeHabit(
  name: string,
  pointsWeight: number,
  period: "daily" | "weekly" = "daily"
) {
  return createHabit(room.id, name, pointsWeight, null, period);
}

/** Same backdating as makeBackfillableUser, for a habit's created_at. */
function makeBackfillableHabit(
  name: string,
  pointsWeight: number,
  period: "daily" | "weekly" = "daily"
) {
  const habit = makeHabit(name, pointsWeight, period);
  db.prepare("UPDATE habits SET created_at = '2000-01-01 00:00:00' WHERE id = ?").run(habit.id);
  return habit;
}

const { weekStart } = getCurrentWeekBounds();
/** A day inside the week just before this one — inside the 3-week backfill window. */
const LAST_WEEK = shiftWeekStart(weekStart, -1);
/** A day inside the oldest week the window reaches — still inside it. */
const TWO_WEEKS_AGO = shiftWeekStart(weekStart, -2);
/** A day inside the week just outside the window — one week too old. */
const TOO_OLD_WEEK = shiftWeekStart(weekStart, -3);

describe("GET /api/habits", () => {
  it("lists only active habits", () => {
    const active = makeHabit("Read Qur'an", 2);
    const inactive = makeHabit("Retired habit", 5);
    updateHabit(inactive.id, { isActive: false });

    const { body } = callList(makeUser());
    const ids = body.map((h: any) => h.id);
    assert.ok(ids.includes(active.id));
    assert.ok(!ids.includes(inactive.id));

    const listed = body.find((h: any) => h.id === active.id);
    assert.deepEqual(listed, {
      id: active.id,
      name: "Read Qur'an",
      description: null,
      period: "daily",
      pointsWeight: 2,
      category: null,
    });
  });
});

describe("POST /api/habits/:id/log", () => {
  it("marks today done, freezing the habit's flat weight", () => {
    const telegramId = makeUser();
    const habit = makeHabit("Salawat", 3);

    const first = callLog(telegramId, habit.id, {});
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, {
      success: true,
      habitId: habit.id,
      value: 1,
      points: 3,
      date: today,
      logged: true,
    });

    // Second call same day overwrites rather than adding.
    const second = callLog(telegramId, habit.id, { value: 1 });
    assert.equal(second.body.value, 1);
    assert.equal(second.body.points, 3);
  });

  it("scores a weekly habit once however many days of the week are marked", () => {
    const telegramId = makeUser();
    const habit = makeHabit("Weekly khatm", 20, "weekly");
    const user = getUserByTelegramId(telegramId)!;

    // Both calls land on the caller's today, so the second is the same row —
    // the week-level cap is exercised properly in repository.test.ts, where the
    // dates can be chosen. Here we only care that the route stays flat.
    assert.equal(callLog(telegramId, habit.id, {}).body.points, 20);
    assert.equal(callLog(telegramId, habit.id, {}).body.points, 20);
    assert.equal(getUserTotalPoints(user.id), 20);
  });

  it("rejects a value other than 1", () => {
    const telegramId = makeUser();
    const habit = makeHabit("Fasted today", 10);

    assert.equal(callLog(telegramId, habit.id, { value: 5 }).status, 400);
    assert.equal(callLog(telegramId, habit.id, { value: -1 }).status, 400);
    assert.equal(callLog(telegramId, habit.id, { value: 1.5 }).status, 400);
    assert.equal(callLog(telegramId, habit.id, { value: 5 }).body.error, "invalid_value");
  });

  it("rejects logging against a deactivated habit", () => {
    const telegramId = makeUser();
    const habit = makeHabit("Soon retired", 5);
    updateHabit(habit.id, { isActive: false });

    const { status, body } = callLog(telegramId, habit.id, {});
    assert.equal(status, 400);
    assert.equal(body.error, "habit_inactive");
  });

  it("404s for an unknown habit id", () => {
    const telegramId = makeUser();
    const { status, body } = callLog(telegramId, 999_999, {});
    assert.equal(status, 404);
    assert.equal(body.error, "habit_not_found");
  });

  it("403s for a telegram id with no registered user", () => {
    const habit = makeHabit("Registered users only", 5);
    const { status, body } = callLog(999_999_999, habit.id, {});
    assert.equal(status, 403);
    assert.equal(body.error, "not_registered");
  });

  it("backfills a daily habit onto an earlier day of this week, and it counts toward the total and the streak", () => {
    const telegramId = makeBackfillableUser();
    const habit = makeBackfillableHabit("Backfilled daily", 7);
    const user = getUserByTelegramId(telegramId)!;

    const { status, body } = callLog(telegramId, habit.id, {}, weekStart);
    assert.equal(status, 200);
    assert.deepEqual(body, {
      success: true,
      habitId: habit.id,
      value: 1,
      points: 7,
      date: weekStart,
      logged: true,
    });
    assert.equal(getUserTotalPoints(user.id), 7);
    assert.equal(getHabitStreak(user.id, habit.id, weekStart), 1);

    // Today itself is untouched — the two days are independent rows.
    assert.equal(callLogWindow(telegramId).body.habits[0].logged, false);
  });

  it("backfills a daily habit into either of the two weeks before this one", () => {
    const telegramId = makeBackfillableUser();
    const habit = makeBackfillableHabit("Backfilled two weeks", 8);
    const user = getUserByTelegramId(telegramId)!;

    assert.equal(callLog(telegramId, habit.id, {}, LAST_WEEK).status, 200);
    assert.equal(callLog(telegramId, habit.id, {}, TWO_WEEKS_AGO).status, 200);
    assert.equal(getUserTotalPoints(user.id), 16);
  });

  it("rejects backfilling into a week older than the 3-week window", () => {
    const telegramId = makeBackfillableUser();
    const habit = makeBackfillableHabit("Too late now", 5);

    const { status, body } = callLog(telegramId, habit.id, {}, TOO_OLD_WEEK);
    assert.equal(status, 400);
    assert.equal(body.error, "date_out_of_window");
  });

  it("rejects a malformed date", () => {
    const telegramId = makeBackfillableUser();
    const habit = makeBackfillableHabit("Bad date", 5);

    for (const bad of ["2026-13-01", "not-a-date", "2026/09/14", "2024-02-30"]) {
      const { status, body } = callLog(telegramId, habit.id, {}, bad);
      assert.equal(status, 400, bad);
      assert.equal(body.error, "invalid_date", bad);
    }
  });

  it("backfills a weekly habit onto an earlier day within the window, banking that week's points", () => {
    const telegramId = makeBackfillableUser();
    const habit = makeBackfillableHabit("Weekly, backfilled", 20, "weekly");
    const user = getUserByTelegramId(telegramId)!;

    const { status, body } = callLog(telegramId, habit.id, {}, LAST_WEEK);
    assert.equal(status, 200);
    assert.equal(body.points, 20);
    assert.equal(getUserTotalPoints(user.id), 20);

    // Today's row for the same habit belongs to a different week (this week),
    // so it independently banks its own points too.
    assert.equal(callLog(telegramId, habit.id, {}).body.points, 20);
    assert.equal(getUserTotalPoints(user.id), 40);
  });

  it("rejects a weekly habit backfilled into a week older than the 3-week window", () => {
    const telegramId = makeBackfillableUser();
    const habit = makeBackfillableHabit("Weekly, too old", 20, "weekly");

    const { status, body } = callLog(telegramId, habit.id, {}, TOO_OLD_WEEK);
    assert.equal(status, 400);
    assert.equal(body.error, "date_out_of_window");
  });

  it("cannot backfill before the caller joined the room", () => {
    const telegramId = makeUser(); // joined "now" — never before this week
    const habit = makeBackfillableHabit("Joined late", 5);

    const { status, body } = callLog(telegramId, habit.id, {}, weekStart);
    if (weekStart === today) return; // nothing earlier than today to test against, this week
    assert.equal(status, 400);
    assert.equal(body.error, "date_out_of_window");
  });

  it("cannot backfill before the habit itself was created", () => {
    const telegramId = makeBackfillableUser();
    const habit = makeHabit("Brand new habit", 5); // created_at left at "now"

    const { status, body } = callLog(telegramId, habit.id, {}, weekStart);
    if (weekStart === today) return; // nothing earlier than today to test against, this week
    assert.equal(status, 400);
    assert.equal(body.error, "date_out_of_window");
  });
});

describe("DELETE /api/habits/:id/log", () => {
  it("removes today's binary log and its points", () => {
    const telegramId = makeUser();
    const habit = makeHabit("Prayed Fajr in jamaat", 15);
    callLog(telegramId, habit.id, {});
    const user = getUserByTelegramId(telegramId)!;
    assert.equal(getUserTotalPoints(user.id), 15);

    const { status, body } = callDeleteLog(telegramId, habit.id);
    assert.equal(status, 200);
    assert.deepEqual(body, { success: true, habitId: habit.id, date: today, logged: false });
    assert.equal(getUserTotalPoints(user.id), 0);
  });

  it("removes today's weekly log and the points it banked", () => {
    const telegramId = makeUser();
    const habit = makeHabit("Weekly unlog", 30, "weekly");
    callLog(telegramId, habit.id, {});
    const user = getUserByTelegramId(telegramId)!;
    assert.equal(getUserTotalPoints(user.id), 30);

    const { status, body } = callDeleteLog(telegramId, habit.id);
    assert.equal(status, 200);
    assert.deepEqual(body, { success: true, habitId: habit.id, date: today, logged: false });
    // Nothing else in the week is marked, so the week loses its points.
    assert.equal(getUserTotalPoints(user.id), 0);
  });

  it("is idempotent when there is no log for today", () => {
    const telegramId = makeUser();
    const habit = makeHabit("Never logged", 5);

    const { status, body } = callDeleteLog(telegramId, habit.id);
    assert.equal(status, 200);
    assert.deepEqual(body, { success: true, habitId: habit.id, date: today, logged: false });
  });

  it("rejects deleting against a deactivated habit — editing is closed entirely once retired", () => {
    const telegramId = makeUser();
    const habit = makeHabit("Soon retired", 5);
    callLog(telegramId, habit.id, {});
    const user = getUserByTelegramId(telegramId)!;
    updateHabit(habit.id, { isActive: false });

    const { status, body } = callDeleteLog(telegramId, habit.id);
    assert.equal(status, 400);
    assert.equal(body.error, "habit_inactive");
    // The existing log is untouched.
    assert.equal(getUserTotalPoints(user.id), 5);
  });

  it("404s for an unknown habit id", () => {
    const telegramId = makeUser();
    const { status, body } = callDeleteLog(telegramId, 999_999);
    assert.equal(status, 404);
    assert.equal(body.error, "habit_not_found");
  });

  it("403s for a telegram id with no registered user", () => {
    const habit = makeHabit("Registered users only", 5);
    const { status, body } = callDeleteLog(999_999_999, habit.id);
    assert.equal(status, 403);
    assert.equal(body.error, "not_registered");
  });

  it("edits an already-backfilled earlier day — off, then back on, within the same window", () => {
    const telegramId = makeBackfillableUser();
    const habit = makeBackfillableHabit("Toggled backfill", 6);
    const user = getUserByTelegramId(telegramId)!;

    callLog(telegramId, habit.id, {}, weekStart);
    assert.equal(getUserTotalPoints(user.id), 6);

    const off = callDeleteLog(telegramId, habit.id, weekStart);
    assert.equal(off.status, 200);
    assert.deepEqual(off.body, {
      success: true,
      habitId: habit.id,
      date: weekStart,
      logged: false,
    });
    assert.equal(getUserTotalPoints(user.id), 0);

    const on = callLog(telegramId, habit.id, {}, weekStart);
    assert.equal(on.status, 200);
    assert.equal(getUserTotalPoints(user.id), 6);
  });

  it("un-marks a day from a week within the 3-week window", () => {
    const telegramId = makeBackfillableUser();
    const habit = makeBackfillableHabit("Backfilled delete", 5);
    const user = getUserByTelegramId(telegramId)!;

    callLog(telegramId, habit.id, {}, LAST_WEEK);
    assert.equal(getUserTotalPoints(user.id), 5);

    const { status, body } = callDeleteLog(telegramId, habit.id, LAST_WEEK);
    assert.equal(status, 200);
    assert.deepEqual(body, { success: true, habitId: habit.id, date: LAST_WEEK, logged: false });
    assert.equal(getUserTotalPoints(user.id), 0);
  });

  it("rejects un-marking a day from a week older than the 3-week window", () => {
    const telegramId = makeBackfillableUser();
    const habit = makeBackfillableHabit("Closed week delete", 5);

    const { status, body } = callDeleteLog(telegramId, habit.id, TOO_OLD_WEEK);
    assert.equal(status, 400);
    assert.equal(body.error, "date_out_of_window");
  });
});

describe("GET /api/habits/log", () => {
  it("defaults to today: the picker's own bounds, and every daily habit's current state", () => {
    const telegramId = makeBackfillableUser();
    const habit = makeBackfillableHabit("Log window default", 4);
    callLog(telegramId, habit.id, {});

    const { status, body } = callLogWindow(telegramId);
    assert.equal(status, 200);
    assert.equal(body.date, today);
    assert.equal(body.today, today);
    assert.equal(body.minDate, TWO_WEEKS_AGO);
    assert.equal(body.maxDate, today);

    const row = body.habits.find((h: any) => h.habitId === habit.id);
    assert.deepEqual(row, {
      habitId: habit.id,
      logged: true,
      value: 1,
      points: 4,
      editable: true,
    });
  });

  it("reports an earlier day's own state, independent of today's", () => {
    // Pre-existing, unrelated to backfill width: when the suite happens to run
    // on a real Monday, weekStart === today and there is no "earlier day" left
    // to distinguish from today in this test.
    if (weekStart === today) return;
    const telegramId = makeBackfillableUser();
    const habit = makeBackfillableHabit("Log window past day", 9);
    callLog(telegramId, habit.id, {}, weekStart);

    const past = callLogWindow(telegramId, weekStart);
    assert.equal(past.body.date, weekStart);
    const pastRow = past.body.habits.find((h: any) => h.habitId === habit.id);
    assert.equal(pastRow.logged, true);
    assert.equal(pastRow.points, 9);

    const present = callLogWindow(telegramId);
    const presentRow = present.body.habits.find((h: any) => h.habitId === habit.id);
    assert.equal(presentRow.logged, false);
  });

  it("includes weekly habits with their own day-specific state, alongside daily ones", () => {
    const telegramId = makeBackfillableUser();
    const weekly = makeBackfillableHabit("Weekly, included", 20, "weekly");
    const daily = makeBackfillableHabit("Daily, here", 3);

    const { body } = callLogWindow(telegramId);
    const ids = body.habits.map((h: any) => h.habitId);
    assert.ok(ids.includes(daily.id));
    assert.ok(ids.includes(weekly.id));

    const weeklyRow = body.habits.find((h: any) => h.habitId === weekly.id);
    assert.equal(weeklyRow.logged, false);
    assert.equal(weeklyRow.countedThisWeek, false);
  });

  it("reports countedThisWeek for a weekly habit's day once another day of the same week carries the points", () => {
    const telegramId = makeBackfillableUser();
    const weekly = makeBackfillableHabit("Weekly, counted", 20, "weekly");

    callLog(telegramId, weekly.id, {}, weekStart);

    const carrierDay = callLogWindow(telegramId, weekStart).body.habits.find(
      (h: any) => h.habitId === weekly.id
    );
    assert.equal(carrierDay.logged, true);
    assert.equal(carrierDay.points, 20);
    assert.equal(carrierDay.countedThisWeek, false);

    // A different, still-unmarked day of the same week: not logged on this
    // exact day, but the week's points already have a home elsewhere.
    if (weekStart !== today) {
      const otherDay = callLogWindow(telegramId, today).body.habits.find(
        (h: any) => h.habitId === weekly.id
      );
      assert.equal(otherDay.logged, false);
      assert.equal(otherDay.countedThisWeek, true);
    }
  });

  it("rejects a malformed date", () => {
    const telegramId = makeBackfillableUser();
    const { status, body } = callLogWindow(telegramId, "2024-02-30");
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_date");
  });

  it("accepts a date within the 3-week window and rejects one older", () => {
    const telegramId = makeBackfillableUser();
    assert.equal(callLogWindow(telegramId, LAST_WEEK).status, 200);
    assert.equal(callLogWindow(telegramId, TWO_WEEKS_AGO).status, 200);

    const { status, body } = callLogWindow(telegramId, TOO_OLD_WEEK);
    assert.equal(status, 400);
    assert.equal(body.error, "date_out_of_window");
  });

  it("403s for a telegram id with no registered user", () => {
    const { status, body } = callLogWindow(999_999_999);
    assert.equal(status, 403);
    assert.equal(body.error, "not_registered");
  });
});
