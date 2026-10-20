import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAmount, formatNumber } from "./formatAmount.ts";

test("minutes over an hour read as hours and minutes", () => {
  assert.equal(formatAmount(870, "min"), "at least 14h 30m");
  assert.equal(formatAmount(1240, "min"), "at least 20h 40m");
  assert.equal(formatAmount(61, "min"), "at least 1h 1m");
});

test("whole hours drop the minutes, and exactly 60 stays minutes", () => {
  assert.equal(formatAmount(1200, "min"), "at least 20h");
  assert.equal(formatAmount(60, "min"), "at least 60 min");
  assert.equal(formatAmount(45, "min"), "at least 45 min");
});

test("the min unit is matched case-insensitively", () => {
  assert.equal(formatAmount(90, "Min"), "at least 1h 30m");
});

test("other units are shown raw, rounded to one decimal", () => {
  assert.equal(formatAmount(87, "pages"), "at least 87 pages");
  assert.equal(formatAmount(2.25, "juz"), "at least 2.3 juz");
  assert.equal(formatAmount(0.1 + 0.2, "km"), "at least 0.3 km");
  assert.equal(formatAmount(12345, "times"), "at least 12,345 times");
});

test("formatNumber keeps at most one decimal", () => {
  assert.equal(formatNumber(14), "14");
  assert.equal(formatNumber(14.04), "14");
  assert.equal(formatNumber(14.06), "14.1");
});
