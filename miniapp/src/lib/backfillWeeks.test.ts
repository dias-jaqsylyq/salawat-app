import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { groupBackfillDays } from "./backfillWeeks.ts";

// 2026-09-14/15/16 are a real Monday/Tuesday/Wednesday, matching the fixture
// dates the bot's habitLogWindow.test.ts uses for the same reason: fixed,
// invented dates so this suite's outcome never depends on which real weekday
// it happens to run on.
const MONDAY = "2026-09-14";
const WEDNESDAY = "2026-09-16";
const MONDAY_LAST_WEEK = "2026-09-07";
const MONDAY_TWO_WEEKS_AGO = "2026-08-31";

describe("groupBackfillDays", () => {
  it("splits the full 3-week window into three labeled, ascending groups", () => {
    const groups = groupBackfillDays(MONDAY_TWO_WEEKS_AGO, WEDNESDAY);

    assert.deepEqual(
      groups.map((g) => g.label),
      ["This week", "Last week", "2 weeks ago"]
    );
    assert.deepEqual(groups[0]!.dates, [MONDAY, "2026-09-15", WEDNESDAY]);
    assert.deepEqual(groups[1]!.dates, [
      MONDAY_LAST_WEEK,
      "2026-09-08",
      "2026-09-09",
      "2026-09-10",
      "2026-09-11",
      "2026-09-12",
      "2026-09-13",
    ]);
    assert.equal(groups[2]!.dates[0], MONDAY_TWO_WEEKS_AGO);
    assert.equal(groups[2]!.dates.length, 7);
  });

  it("omits empty sections — a brand-new window shows only this week", () => {
    const groups = groupBackfillDays(MONDAY, WEDNESDAY);
    assert.deepEqual(
      groups.map((g) => g.label),
      ["This week"]
    );
  });

  it("collapses to a single day for a member with no headroom at all", () => {
    const groups = groupBackfillDays(WEDNESDAY, WEDNESDAY);
    assert.deepEqual(groups, [{ label: "This week", dates: [WEDNESDAY] }]);
  });
});
