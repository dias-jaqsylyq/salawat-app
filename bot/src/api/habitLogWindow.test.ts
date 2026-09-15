import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.BOT_TOKEN ??= "habit-log-window-test";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH ??= ":memory:";

const {
  createHabit,
  createRoom,
  createUser,
  getHabitById,
  getUserByTelegramId,
  setUserCurrentRoom,
} = await import("../db/repository.js");
const { db } = await import("../db/client.js");
const { dailyLogWindow } = await import("./habitLogWindow.js");

let nextTelegramId = 760000001;

function makeRoomAndUser(): { roomId: number; telegramId: number } {
  const telegramId = nextTelegramId++;
  const owner = createUser(telegramId, `window-tester-${telegramId}`);
  const room = createRoom(`Window room ${telegramId}`, `window-pass-${telegramId}`, owner.id);
  setUserCurrentRoom(owner.id, room.id);
  return { roomId: room.id, telegramId };
}

function setRoomJoinedAt(telegramId: number, sqliteUtc: string): void {
  db.prepare("UPDATE users SET room_joined_at = ? WHERE telegram_id = ?").run(
    sqliteUtc,
    telegramId
  );
}

function setHabitCreatedAt(habitId: number, sqliteUtc: string): void {
  db.prepare("UPDATE habits SET created_at = ? WHERE id = ?").run(sqliteUtc, habitId);
}

/**
 * Every date below is a fixed, invented instant passed as `dailyLogWindow`'s
 * `now` — never the real clock — so this suite's outcome never depends on
 * which real weekday it happens to run on. 2026-09-14/15/16 are a real
 * Monday/Tuesday/Wednesday of the same week; 2026-09-13 is the Sunday before.
 */
const NOW_WEDNESDAY = new Date("2026-09-16T04:00:00Z"); // noon in Hong Kong
const MONDAY = "2026-09-14";
const TUESDAY = "2026-09-15";
const WEDNESDAY = "2026-09-16";
const SUNDAY_LAST_WEEK = "2026-09-13";

describe("dailyLogWindow", () => {
  it("spans the whole current week, Monday through today, when nothing narrows it further", () => {
    const { telegramId } = makeRoomAndUser();
    setRoomJoinedAt(telegramId, "2020-01-01 00:00:00");
    const user = getUserByTelegramId(telegramId)!;

    const window = dailyLogWindow(user, undefined, NOW_WEDNESDAY);
    assert.deepEqual(window, { today: WEDNESDAY, minDate: MONDAY, maxDate: WEDNESDAY });
  });

  it("narrows the lower bound to the day the member joined the room", () => {
    const { telegramId } = makeRoomAndUser();
    setRoomJoinedAt(telegramId, "2026-09-15 04:00:00"); // noon Tuesday in Hong Kong
    const user = getUserByTelegramId(telegramId)!;

    const window = dailyLogWindow(user, undefined, NOW_WEDNESDAY);
    assert.equal(window.minDate, TUESDAY);
  });

  it("never narrows past the current week's Monday, however early the member joined", () => {
    const { telegramId } = makeRoomAndUser();
    setRoomJoinedAt(telegramId, "2020-01-01 00:00:00");
    const user = getUserByTelegramId(telegramId)!;

    const window = dailyLogWindow(user, undefined, NOW_WEDNESDAY);
    assert.equal(window.minDate, MONDAY);
  });

  it("narrows further, for one specific habit, to the day that habit was created", () => {
    const { roomId, telegramId } = makeRoomAndUser();
    setRoomJoinedAt(telegramId, "2020-01-01 00:00:00");
    const created = createHabit(roomId, "New this week", 5);
    setHabitCreatedAt(created.id, "2026-09-15 04:00:00"); // noon Tuesday in Hong Kong
    const habit = getHabitById(created.id)!;
    const user = getUserByTelegramId(telegramId)!;

    const forThisHabit = dailyLogWindow(user, habit, NOW_WEDNESDAY);
    assert.equal(forThisHabit.minDate, TUESDAY);

    // The screen-wide window (no habit given) is the picker's own control and
    // is not narrowed by any one habit's age.
    const screenWide = dailyLogWindow(user, undefined, NOW_WEDNESDAY);
    assert.equal(screenWide.minDate, MONDAY);
  });

  it("takes whichever of week-start, join day and habit-created day is latest", () => {
    const { roomId, telegramId } = makeRoomAndUser();
    setRoomJoinedAt(telegramId, "2026-09-14 04:00:00"); // noon Monday — still narrower than 2020
    const created = createHabit(roomId, "Created Wednesday", 5);
    setHabitCreatedAt(created.id, "2026-09-16 04:00:00"); // noon Wednesday — later than the join day
    const habit = getHabitById(created.id)!;
    const user = getUserByTelegramId(telegramId)!;

    const window = dailyLogWindow(user, habit, NOW_WEDNESDAY);
    assert.equal(window.minDate, WEDNESDAY);
  });

  it("collapses to just today rather than inverting, when the room's TIMEZONE week has already rolled over ahead of the member's own zone", () => {
    const { telegramId } = makeRoomAndUser();
    setRoomJoinedAt(telegramId, "2020-01-01 00:00:00");
    const user = getUserByTelegramId(telegramId)!;
    // Pacific/Midway is UTC-11, far enough behind Asia/Hong_Kong (TIMEZONE)
    // that this member can still be living Sunday after Hong Kong has already
    // turned Monday.
    user.timezone = "Pacific/Midway";

    const justAfterHongKongRollsToMonday = new Date("2026-09-13T16:30:00Z");
    const window = dailyLogWindow(user, undefined, justAfterHongKongRollsToMonday);

    assert.equal(window.today, SUNDAY_LAST_WEEK);
    assert.equal(window.minDate, window.today);
    assert.equal(window.maxDate, window.today);
  });
});
