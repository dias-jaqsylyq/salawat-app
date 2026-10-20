import { test } from "node:test";
import assert from "node:assert/strict";
import { chartBars, chartSummary, shortDate } from "./statsChart.ts";

test("weeks before the habit existed get no bar at all", () => {
  const bars = chartBars([null, null, null, null, null, 2, 4, 1], 7, 6);
  assert.deepEqual(
    bars.map((b) => b.index),
    [5, 6, 7]
  );
});

test("heights are relative to the tallest week, and a zero week is a stub", () => {
  const bars = chartBars([0, 4, 2, 0, 0, 0, 0, 8], 7, 1);
  assert.equal(bars[0]!.height, 0);
  assert.equal(bars[1]!.height, 0.5);
  assert.equal(bars[7]!.height, 1);
});

test("a tiny non-zero week stays visible", () => {
  const bars = chartBars([1000, 1, 0, 0, 0, 0, 0, 0], 7, 0);
  assert.ok(bars[1]!.height > 0);
});

test("flags the current and the best week", () => {
  const bars = chartBars([1, 3, 2, 0, 0, 0, 0, 9], 7, 1);
  assert.deepEqual(
    bars.filter((b) => b.isBest).map((b) => b.index),
    [1]
  );
  assert.deepEqual(
    bars.filter((b) => b.isCurrent).map((b) => b.index),
    [7]
  );
});

test("an all-zero chart has no tall bars and no division by zero", () => {
  const bars = chartBars([0, 0, 0, 0, 0, 0, 0, 0], 7, null);
  assert.ok(bars.every((b) => b.height === 0));
});

test("summary and dates read naturally", () => {
  assert.equal(shortDate("2026-02-03"), "3 Feb");
  const weekStarts = ["2026-02-02", "2026-02-09"];
  assert.equal(
    chartSummary(chartBars([3, 1], 1, 0), weekStarts),
    "week of 2 Feb: 3 (best), this week so far: 1"
  );
});
