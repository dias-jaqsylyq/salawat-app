import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatMonthLabel, shiftMonthKey } from "./monthKey.ts";

describe("shiftMonthKey", () => {
  it("moves forward and backward within a year", () => {
    assert.equal(shiftMonthKey("2026-09", 1), "2026-10");
    assert.equal(shiftMonthKey("2026-09", -1), "2026-08");
  });

  it("wraps across a year boundary in both directions", () => {
    assert.equal(shiftMonthKey("2026-12", 1), "2027-01");
    assert.equal(shiftMonthKey("2026-01", -1), "2025-12");
  });

  it("wraps across more than one year", () => {
    assert.equal(shiftMonthKey("2026-01", -14), "2024-11");
  });
});

describe("formatMonthLabel", () => {
  it("renders a full month name and year", () => {
    assert.equal(formatMonthLabel("2026-09"), "September 2026");
    assert.equal(formatMonthLabel("2026-01"), "January 2026");
  });
});
