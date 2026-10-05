import { test } from "node:test";
import assert from "node:assert/strict";
import { validateExtendedPoints } from "./extendedLevel.ts";

test("an off toggle never blocks the form", () => {
  assert.equal(validateExtendedPoints(false, "", "3", 1000), null);
});

test("extended points are a whole number, at least the base", () => {
  assert.equal(validateExtendedPoints(true, "2", "1", 1000), null);
  assert.equal(validateExtendedPoints(true, "2", "2", 1000), null);
  assert.match(validateExtendedPoints(true, "1", "2", 1000)!, /lower than the basic/);
  assert.match(validateExtendedPoints(true, "", "1", 1000)!, /whole number/);
  assert.match(validateExtendedPoints(true, "1.5", "1", 1000)!, /whole number/);
  assert.match(validateExtendedPoints(true, "2000", "1", 1000)!, /whole number/);
});
