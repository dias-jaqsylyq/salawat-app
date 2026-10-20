import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAmountFields } from "./habitAmount.ts";

function fields(unit: string, basic: string, extended = "", withExtended = false) {
  const result = parseAmountFields(unit, basic, extended, withExtended);
  return result.ok ? result.fields : result.error;
}

test("all empty means no estimate", () => {
  assert.deepEqual(fields("", ""), { unitLabel: null, amountBasic: null, amountExtended: null });
});

test("trims the unit and accepts decimals with a dot or a comma", () => {
  assert.deepEqual(fields(" min ", "30"), { unitLabel: "min", amountBasic: 30, amountExtended: null });
  assert.deepEqual(fields("juz", "0,5"), { unitLabel: "juz", amountBasic: 0.5, amountExtended: null });
  assert.deepEqual(fields("min", "30", "45.5", true), {
    unitLabel: "min",
    amountBasic: 30,
    amountExtended: 45.5,
  });
});

test("a unit alone is allowed", () => {
  assert.deepEqual(fields("pages", ""), { unitLabel: "pages", amountBasic: null, amountExtended: null });
});

test("drops the Extended amount when the habit has no Extended level", () => {
  assert.deepEqual(fields("min", "30", "45", false), {
    unitLabel: "min",
    amountBasic: 30,
    amountExtended: null,
  });
});

test("refuses what the server refuses", () => {
  assert.match(fields("x".repeat(17), "1") as string, /1–16 characters/);
  assert.match(fields("<b>", "1") as string, /without < or >/);
  assert.match(fields("min", "0") as string, /above 0/);
  assert.match(fields("min", "100001") as string, /at most 100,000/);
  assert.match(fields("min", "abc") as string, /above 0/);
  assert.match(fields("", "30") as string, /Enter a unit/);
  assert.match(fields("min", "", "45", true) as string, /basic amount first/);
  assert.match(fields("min", "30", "20", true) as string, /can't be lower/);
});
