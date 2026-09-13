import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.BOT_TOKEN ??= "test-token";
process.env.CHALLENGE_START_DATE ??= "2026-08-01";
process.env.CHALLENGE_END_DATE ??= "2026-09-01";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH ??= ":memory:";

const {
  computePoints,
  createHabit,
  createRoom,
  setUserCurrentRoom,
  createUser,
  deactivateHabit,
  deleteHabitLog,
  getHabitById,
  getHabitStreak,
  getUserHabitLogsForDate,
  getUserTotalPoints,
  getWeeklyHabitLogCount,
  getWeeklyHabitStreak,
  getWeeklyLeaderboard,
  listHabits,
  updateHabit,
  upsertHabitLog,
} = await import("./repository.js");
const { db } = await import("./client.js");

let nextTelegramId = 600000001;

/** One shared room for these unit tests — room scoping itself lives in rooms.test.ts. */
const room = (() => {
  const owner = createUser(nextTelegramId++, "repository-room-owner");
  return createRoom("Repository room", "repository-room-pass", owner.id);
})();

function makeUser(): number {
  const user = createUser(nextTelegramId++, `tester-${nextTelegramId}`);
  setUserCurrentRoom(user.id, room.id);
  return user.id;
}

function makeHabit(
  name: string,
  pointsWeight: number,
  period: "daily" | "weekly" = "daily"
) {
  return createHabit(room.id, name, pointsWeight, null, period);
}

describe("computePoints", () => {
  it("daily: flat points_weight, every day", () => {
    assert.equal(computePoints({ period: "daily", points_weight: 20 }), 20);
    // A daily habit is never "already banked" — each day stands on its own.
    assert.equal(computePoints({ period: "daily", points_weight: 20 }, true), 20);
  });

  it("weekly: the weight once, then nothing for the rest of the week", () => {
    assert.equal(computePoints({ period: "weekly", points_weight: 20 }, false), 20);
    assert.equal(computePoints({ period: "weekly", points_weight: 20 }, true), 0);
  });
});

describe("upsertHabitLog", () => {
  it("freezes flat points_earned for a daily habit", () => {
    const userId = makeUser();
    const habit = makeHabit("Fasted today", 25);

    const log = upsertHabitLog(userId, habit.id, 1, "2026-08-14");

    assert.equal(log.value, 1);
    assert.equal(log.points_earned, 25);
    assert.equal(log.log_date, "2026-08-14");
  });

  it("upserts on the same day: overwrites rather than accumulates", () => {
    const userId = makeUser();
    const habit = makeHabit("Quran pages", 5);

    upsertHabitLog(userId, habit.id, 1, "2026-08-14");
    const second = upsertHabitLog(userId, habit.id, 1, "2026-08-14");

    const rows = db
      .prepare("SELECT * FROM habit_logs WHERE user_id = ? AND habit_id = ?")
      .all(userId, habit.id) as { value: number; points_earned: number }[];

    assert.equal(rows.length, 1);
    assert.equal(second.points_earned, 5);
    assert.equal(getUserTotalPoints(userId), 5);
  });
});

describe("habit weight changes are not retroactive", () => {
  it("keeps an already-logged day's points frozen after the habit's weight changes", () => {
    const userId = makeUser();
    const habit = makeHabit("Dhikr count", 10);

    const day1 = upsertHabitLog(userId, habit.id, 1, "2026-08-14");
    assert.equal(day1.points_earned, 10);

    updateHabit(habit.id, { pointsWeight: 100 });

    const day2 = upsertHabitLog(userId, habit.id, 1, "2026-08-15");
    assert.equal(day2.points_earned, 100);

    const day1Reloaded = db
      .prepare("SELECT points_earned FROM habit_logs WHERE user_id = ? AND habit_id = ? AND log_date = ?")
      .get(userId, habit.id, "2026-08-14") as { points_earned: number };
    assert.equal(day1Reloaded.points_earned, 10);

    assert.equal(getUserTotalPoints(userId), 110);
  });
});

describe("habit CRUD", () => {
  it("creates, lists (active-only vs all), and deactivates habits", () => {
    const active = makeHabit("Prayed Fajr in jamaat", 15);
    const toDeactivate = makeHabit("Old habit", 5);

    assert.equal(getHabitById(active.id)?.is_active, 1);

    const deactivated = deactivateHabit(toDeactivate.id);
    assert.equal(deactivated.is_active, 0);

    const activeOnly = listHabits({ activeOnly: true }).map((h) => h.id);
    assert.ok(activeOnly.includes(active.id));
    assert.ok(!activeOnly.includes(toDeactivate.id));

    const all = listHabits().map((h) => h.id);
    assert.ok(all.includes(active.id));
    assert.ok(all.includes(toDeactivate.id));
  });
});

describe("getHabitStreak", () => {
  it("counts consecutive logged days and stops at a gap", () => {
    const userId = makeUser();
    const habit = makeHabit("Qiyam al-layl", 30);

    upsertHabitLog(userId, habit.id, 1, "2026-08-12");
    upsertHabitLog(userId, habit.id, 1, "2026-08-13");
    upsertHabitLog(userId, habit.id, 1, "2026-08-14");
    // 2026-08-11 intentionally skipped, breaking the streak beyond the 12th.

    assert.equal(getHabitStreak(userId, habit.id, "2026-08-14"), 3);
    assert.equal(getHabitStreak(userId, habit.id, "2026-08-15"), 0);
  });
});

describe("deleteHabitLog", () => {
  it("removes the row so the day drops out of the streak and today's totals", () => {
    const userId = makeUser();
    const habit = makeHabit("Qiyam al-layl", 30);

    upsertHabitLog(userId, habit.id, 1, "2026-08-12");
    upsertHabitLog(userId, habit.id, 1, "2026-08-13");
    upsertHabitLog(userId, habit.id, 1, "2026-08-14");
    assert.equal(getHabitStreak(userId, habit.id, "2026-08-14"), 3);
    assert.equal(getUserTotalPoints(userId), 90);

    deleteHabitLog(userId, habit.id, "2026-08-14");

    assert.equal(getHabitStreak(userId, habit.id, "2026-08-14"), 0);
    assert.equal(getUserTotalPoints(userId), 60);
    assert.equal(getUserHabitLogsForDate(userId, "2026-08-14").has(habit.id), false);
  });

  it("is a no-op when there is no log for that day", () => {
    const userId = makeUser();
    const habit = makeHabit("Qiyam al-layl", 30);

    assert.doesNotThrow(() => deleteHabitLog(userId, habit.id, "2026-08-14"));
    assert.equal(getUserTotalPoints(userId), 0);
  });
});

describe("getUserTotalPoints", () => {
  it("sums each user's own points independently", () => {
    const alice = makeUser();
    const bob = makeUser();
    const habit = makeHabit("Sadaqah given", 40);

    upsertHabitLog(alice, habit.id, 1, "2026-08-14");
    upsertHabitLog(bob, habit.id, 1, "2026-08-14");

    assert.equal(getUserTotalPoints(alice), 40);
    assert.equal(getUserTotalPoints(bob), 40);
  });
});

/**
 * 2026-09-14 is a Monday, so 2026-09-14..2026-09-20 is one whole week and
 * 2026-09-21 is the Monday after it. Fixed dates rather than "today" on
 * purpose: a weekly rule is exactly the kind of thing that passes on a
 * Wednesday and fails on a Sunday.
 */
const MON = "2026-09-14";
const WED = "2026-09-16";
const SUN = "2026-09-20";
const NEXT_MON = "2026-09-21";

function pointsOn(userId: number, habitId: number, date: string): number {
  const row = db
    .prepare(
      "SELECT points_earned FROM habit_logs WHERE user_id = ? AND habit_id = ? AND log_date = ?"
    )
    .get(userId, habitId, date) as { points_earned: number } | undefined;
  return row?.points_earned ?? 0;
}

describe("weekly habits score at most once a week", () => {
  it("banks the weight on the first marked day and nothing on later ones", () => {
    const userId = makeUser();
    const habit = makeHabit("Weekly sadaqah", 5, "weekly");

    assert.equal(upsertHabitLog(userId, habit.id, 1, MON).points_earned, 5);
    assert.equal(upsertHabitLog(userId, habit.id, 1, WED).points_earned, 0);
    assert.equal(upsertHabitLog(userId, habit.id, 1, SUN).points_earned, 0);

    // Three marked days, one payout.
    assert.equal(getWeeklyHabitLogCount(userId, habit.id, MON, SUN), 3);
    assert.equal(getUserTotalPoints(userId), 5);
  });

  it("re-marking the day that carries the week keeps it carrying", () => {
    const userId = makeUser();
    const habit = makeHabit("Weekly re-mark", 7, "weekly");

    upsertHabitLog(userId, habit.id, 1, MON);
    assert.equal(upsertHabitLog(userId, habit.id, 1, MON).points_earned, 7);
    assert.equal(getUserTotalPoints(userId), 7);
  });

  it("pays again in the next week", () => {
    const userId = makeUser();
    const habit = makeHabit("Weekly across weeks", 9, "weekly");

    upsertHabitLog(userId, habit.id, 1, SUN);
    upsertHabitLog(userId, habit.id, 1, NEXT_MON);

    assert.equal(getUserTotalPoints(userId), 18);
  });

  it("leaves daily habits scoring every single day", () => {
    const userId = makeUser();
    const habit = makeHabit("Daily dhikr", 3);

    upsertHabitLog(userId, habit.id, 1, MON);
    upsertHabitLog(userId, habit.id, 1, WED);

    assert.equal(getUserTotalPoints(userId), 6);
  });
});

describe("unmarking a weekly habit hands the week's points on", () => {
  it("moves the weight to the earliest surviving day of the week", () => {
    const userId = makeUser();
    const habit = makeHabit("Weekly handover", 5, "weekly");

    upsertHabitLog(userId, habit.id, 1, MON);
    upsertHabitLog(userId, habit.id, 1, WED);
    assert.equal(pointsOn(userId, habit.id, MON), 5);
    assert.equal(pointsOn(userId, habit.id, WED), 0);

    deleteHabitLog(userId, habit.id, MON);

    // The member still did it this week, so the week is still worth 5 — it has
    // just moved to the day that is still marked.
    assert.equal(pointsOn(userId, habit.id, WED), 5);
    assert.equal(getUserTotalPoints(userId), 5);
  });

  it("only zeroes the week when its last marked day goes", () => {
    const userId = makeUser();
    const habit = makeHabit("Weekly last day", 5, "weekly");

    upsertHabitLog(userId, habit.id, 1, MON);
    upsertHabitLog(userId, habit.id, 1, WED);
    deleteHabitLog(userId, habit.id, MON);
    deleteHabitLog(userId, habit.id, WED);

    assert.equal(getUserTotalPoints(userId), 0);
    assert.equal(getWeeklyHabitLogCount(userId, habit.id, MON, SUN), 0);
  });

  it("never lets a handover reach into the neighbouring week", () => {
    const userId = makeUser();
    const habit = makeHabit("Weekly no bleed", 5, "weekly");

    upsertHabitLog(userId, habit.id, 1, SUN);
    upsertHabitLog(userId, habit.id, 1, NEXT_MON);
    assert.equal(getUserTotalPoints(userId), 10);

    deleteHabitLog(userId, habit.id, SUN);

    // Next Monday keeps its own week's points; the week just emptied is worth 0.
    assert.equal(pointsOn(userId, habit.id, NEXT_MON), 5);
    assert.equal(getUserTotalPoints(userId), 5);
  });

  it("hands on the deleted row's frozen points, not the habit's current weight", () => {
    const userId = makeUser();
    const habit = makeHabit("Weekly reweighted", 5, "weekly");

    upsertHabitLog(userId, habit.id, 1, MON);
    upsertHabitLog(userId, habit.id, 1, WED);
    updateHabit(habit.id, { pointsWeight: 500 });
    deleteHabitLog(userId, habit.id, MON);

    // The week was earned at 5 and stays worth 5: a weight change is never
    // retroactive, here as everywhere else.
    assert.equal(pointsOn(userId, habit.id, WED), 5);
  });

  it("is still a plain idempotent delete for a daily habit", () => {
    const userId = makeUser();
    const habit = makeHabit("Daily delete", 4);

    upsertHabitLog(userId, habit.id, 1, MON);
    upsertHabitLog(userId, habit.id, 1, WED);
    deleteHabitLog(userId, habit.id, MON);
    deleteHabitLog(userId, habit.id, MON);

    assert.equal(getUserTotalPoints(userId), 4);
    assert.equal(pointsOn(userId, habit.id, WED), 4);
  });
});

describe("getWeeklyHabitStreak", () => {
  it("counts weeks, not days: three days of one week is still one week", () => {
    const userId = makeUser();
    const habit = makeHabit("Weekly streak one", 5, "weekly");

    upsertHabitLog(userId, habit.id, 1, MON);
    upsertHabitLog(userId, habit.id, 1, WED);
    upsertHabitLog(userId, habit.id, 1, SUN);

    assert.equal(getWeeklyHabitStreak(userId, habit.id, MON), 1);
  });

  it("gives the current week grace so a run never drops mid-week", () => {
    const userId = makeUser();
    const habit = makeHabit("Weekly streak grace", 5, "weekly");

    upsertHabitLog(userId, habit.id, 1, "2026-08-31"); // Mon, 3 weeks before
    upsertHabitLog(userId, habit.id, 1, "2026-09-07"); // Mon, 2 weeks before
    upsertHabitLog(userId, habit.id, 1, WED); // this week

    // Standing in the week after the run, with nothing logged in it yet: the
    // three finished weeks still count rather than collapsing to 0.
    assert.equal(getWeeklyHabitStreak(userId, habit.id, NEXT_MON), 3);
    // And logging that week turns 3 into 4 rather than 0 into 1.
    upsertHabitLog(userId, habit.id, 1, NEXT_MON);
    assert.equal(getWeeklyHabitStreak(userId, habit.id, NEXT_MON), 4);
  });

  it("stops at a skipped week", () => {
    const userId = makeUser();
    const habit = makeHabit("Weekly streak gap", 5, "weekly");

    upsertHabitLog(userId, habit.id, 1, "2026-08-31"); // Mon
    // 2026-09-07 week skipped.
    upsertHabitLog(userId, habit.id, 1, MON);

    assert.equal(getWeeklyHabitStreak(userId, habit.id, MON), 1);
  });

  it("is 0 for a habit that was never marked", () => {
    const userId = makeUser();
    const habit = makeHabit("Weekly streak none", 5, "weekly");

    assert.equal(getWeeklyHabitStreak(userId, habit.id, MON), 0);
  });
});

describe("getWeeklyLeaderboard", () => {
  it("counts only the week asked for, and keeps members who scored nothing", () => {
    const scorer = makeUser();
    const idler = makeUser();
    const daily = makeHabit("Weekly board daily", 3);
    const weekly = makeHabit("Weekly board weekly", 10, "weekly");

    upsertHabitLog(scorer, daily.id, 1, MON);
    upsertHabitLog(scorer, weekly.id, 1, WED);
    // Last week and next week must not leak into this week's figure.
    upsertHabitLog(scorer, daily.id, 1, "2026-09-07");
    upsertHabitLog(scorer, daily.id, 1, NEXT_MON);

    const rows = getWeeklyLeaderboard(room.id, MON, SUN);
    const byId = new Map(rows.map((r) => [r.user_id, r.total]));

    // Daily 3 + weekly 10, and nothing from the weeks either side.
    assert.equal(byId.get(scorer), 13);
    // A member with no points this week is still on the board, at 0.
    assert.equal(byId.get(idler), 0);
  });
});
