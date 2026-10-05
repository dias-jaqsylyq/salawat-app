import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dayProgress,
  effectiveLevel,
  levelAfterTap,
  logKey,
  markedDatesWith,
  serverLevel,
  toggleFeedback,
  withOverride,
  withoutOverrides,
  type DaySnapshot,
} from "./logState.ts";

test("logKey keeps room and personal ids apart", () => {
  assert.notEqual(logKey("2026-09-27", "room", 1), logKey("2026-09-27", "personal", 1));
  assert.notEqual(logKey("2026-09-27", "room", 1), logKey("2026-09-26", "room", 1));
});

test("an override wins over the server until it is dropped", () => {
  const key = logKey("2026-09-27", "room", 7);
  const overrides = withOverride({}, key, "basic");
  assert.equal(effectiveLevel(overrides, key, "off"), "basic");
  assert.equal(effectiveLevel(overrides, logKey("2026-09-27", "room", 8), "off"), "off");
  assert.equal(effectiveLevel(withoutOverrides(overrides, [key]), key, "off"), "off");
});

test("an override to off hides a server-side log", () => {
  const key = logKey("2026-09-27", "personal", 3);
  assert.equal(effectiveLevel(withOverride({}, key, "off"), key, "extended"), "off");
});

test("serverLevel reads the logged level, and an older server's missing level as Basic", () => {
  assert.equal(serverLevel({ logged: false, level: null }), "off");
  assert.equal(serverLevel({ logged: true, level: "extended" }), "extended");
  assert.equal(serverLevel({ logged: true }), "basic");
});

test("tapping the selected level clears the day; any other level selects it", () => {
  assert.equal(levelAfterTap("basic", "basic"), "off");
  assert.equal(levelAfterTap("extended", "extended"), "off");
  assert.equal(levelAfterTap("basic", "extended"), "extended");
  assert.equal(levelAfterTap("extended", "basic"), "basic");
  assert.equal(levelAfterTap("off", "basic"), "basic");
});

test("dayProgress counts only editable habits, and banked weekly ones as done", () => {
  assert.deepEqual(
    dayProgress([
      { logged: true, editable: true },
      { logged: false, editable: true },
      { logged: false, editable: true, countedThisWeek: true },
      { logged: true, editable: false },
      { logged: false, editable: false },
    ]),
    { done: 2, total: 3, complete: false }
  );
});

test("dayProgress is complete only with at least one habit", () => {
  assert.equal(dayProgress([]).complete, false);
  assert.equal(dayProgress([{ logged: false, editable: false }]).complete, false);
  assert.equal(dayProgress([{ logged: true, editable: true }]).complete, true);
});

test("markedDatesWith re-derives the viewed day only", () => {
  const server = ["2026-09-20", "2026-09-27"];
  assert.deepEqual([...markedDatesWith(server, "2026-09-27", false)], ["2026-09-20"]);
  assert.deepEqual(
    [...markedDatesWith(server, "2026-09-25", true)].sort(),
    ["2026-09-20", "2026-09-25", "2026-09-27"]
  );
});

function snap(marks: number, done: number, total: number): DaySnapshot {
  return { marks, progress: { done, total, complete: total > 0 && done === total } };
}

test("toggleFeedback: first mark, finishing the day, and everything else", () => {
  assert.equal(toggleFeedback(snap(0, 0, 5), snap(1, 1, 5)), "first");
  assert.equal(toggleFeedback(snap(4, 4, 5), snap(5, 5, 5)), "complete");
  // A one-habit day: finishing it wins over "first".
  assert.equal(toggleFeedback(snap(0, 0, 1), snap(1, 1, 1)), "complete");
  assert.equal(toggleFeedback(snap(2, 2, 5), snap(3, 3, 5)), "tap");
  assert.equal(toggleFeedback(snap(3, 3, 5), snap(2, 2, 5)), "tap");
  // A personal habit as the first mark of a day with nothing from the room done.
  assert.equal(toggleFeedback(snap(0, 0, 5), snap(1, 0, 5)), "first");
});
