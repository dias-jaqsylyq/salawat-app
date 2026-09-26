import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { backfillWeekView, dayForWeekStep, mondayOf, weekLabel } from "./backfillWeeks.ts";

// 2026-09-14/15/16 are a real Monday/Tuesday/Wednesday, matching the fixture
// dates the bot's habitLogWindow.test.ts uses for the same reason: fixed,
// invented dates so this suite's outcome never depends on which real weekday
// it happens to run on.
const MONDAY = "2026-09-14";
const WEDNESDAY = "2026-09-16";
const SUNDAY = "2026-09-20";
const MONDAY_LAST_WEEK = "2026-09-07";
const SUNDAY_LAST_WEEK = "2026-09-13";
const MONDAY_TWO_WEEKS_AGO = "2026-08-31";
const SUNDAY_TWO_WEEKS_AGO = "2026-09-06";

describe("mondayOf", () => {
  it("maps every day of a week, Sunday included, to that week's Monday", () => {
    assert.equal(mondayOf(MONDAY), MONDAY);
    assert.equal(mondayOf(WEDNESDAY), MONDAY);
    assert.equal(mondayOf(SUNDAY), MONDAY);
  });
});

describe("backfillWeekView", () => {
  it("shows the current week Monday-Sunday, future days inert, ► blocked", () => {
    const view = backfillWeekView(MONDAY_TWO_WEEKS_AGO, WEDNESDAY, WEDNESDAY);

    assert.equal(view.label, "This week");
    assert.equal(view.days.length, 7);
    assert.equal(view.days[0]!.date, MONDAY);
    assert.equal(view.days[6]!.date, SUNDAY);
    assert.deepEqual(
      view.days.map((d) => d.selectable),
      [true, true, true, false, false, false, false]
    );
    assert.equal(view.canGoForward, false);
    assert.equal(view.canGoBack, true);
  });

  it("labels the two earlier weeks and blocks ◄ on the oldest one", () => {
    const last = backfillWeekView(MONDAY_TWO_WEEKS_AGO, WEDNESDAY, SUNDAY_LAST_WEEK);
    assert.equal(last.label, "Last week");
    assert.equal(last.canGoBack, true);
    assert.equal(last.canGoForward, true);

    const oldest = backfillWeekView(MONDAY_TWO_WEEKS_AGO, WEDNESDAY, SUNDAY_TWO_WEEKS_AGO);
    assert.equal(oldest.label, "2 weeks ago");
    assert.equal(oldest.canGoBack, false);
    assert.ok(oldest.days.every((d) => d.selectable));
  });

  it("blocks ◄ and greys out the days before a mid-week join", () => {
    const joined = "2026-09-10"; // last Thursday
    const view = backfillWeekView(joined, WEDNESDAY, SUNDAY_LAST_WEEK);
    assert.equal(view.canGoBack, false);
    assert.deepEqual(
      view.days.map((d) => d.selectable),
      [false, false, false, true, true, true, true]
    );
  });

  it("blocks ◄ on the current week for a member who joined this week", () => {
    assert.equal(backfillWeekView(MONDAY, WEDNESDAY, WEDNESDAY).canGoBack, false);
  });
});

describe("dayForWeekStep", () => {
  it("lands on the previous week's Sunday", () => {
    assert.equal(dayForWeekStep(MONDAY_TWO_WEEKS_AGO, WEDNESDAY, WEDNESDAY, -1), SUNDAY_LAST_WEEK);
    assert.equal(
      dayForWeekStep(MONDAY_TWO_WEEKS_AGO, WEDNESDAY, MONDAY_LAST_WEEK, -1),
      SUNDAY_TWO_WEEKS_AGO
    );
  });

  it("lands on today, not a future Sunday, when stepping back into the current week", () => {
    assert.equal(dayForWeekStep(MONDAY_TWO_WEEKS_AGO, WEDNESDAY, SUNDAY_LAST_WEEK, 1), WEDNESDAY);
  });

  it("refuses to step outside the window either way", () => {
    assert.equal(dayForWeekStep(MONDAY_TWO_WEEKS_AGO, WEDNESDAY, MONDAY_TWO_WEEKS_AGO, -1), null);
    assert.equal(dayForWeekStep(MONDAY, WEDNESDAY, WEDNESDAY, -1), null);
    assert.equal(dayForWeekStep(MONDAY_TWO_WEEKS_AGO, WEDNESDAY, WEDNESDAY, 1), null);
  });
});

describe("weekLabel", () => {
  it("uses the reference wording", () => {
    assert.deepEqual([0, 1, 2].map(weekLabel), ["This week", "Last week", "2 weeks ago"]);
  });
});
