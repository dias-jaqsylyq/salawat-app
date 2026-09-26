import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { autoDeleteConfirmLine, resolveAutoDeleteHours } from "./broadcastAutoDelete.ts";

describe("resolveAutoDeleteHours", () => {
  it("keeps the post forever when the box is ticked, whatever the field says", () => {
    assert.deepEqual(resolveAutoDeleteHours(true, ""), { hours: null });
    assert.deepEqual(resolveAutoDeleteHours(true, "abc"), { hours: null });
  });

  it("defaults an empty field to 24 hours", () => {
    assert.deepEqual(resolveAutoDeleteHours(false, ""), { hours: 24 });
    assert.deepEqual(resolveAutoDeleteHours(false, "  "), { hours: 24 });
  });

  it("accepts whole hours from 1 to 720", () => {
    assert.deepEqual(resolveAutoDeleteHours(false, "1"), { hours: 1 });
    assert.deepEqual(resolveAutoDeleteHours(false, " 720 "), { hours: 720 });
  });

  it("rejects fractions, zero, signs and values over 720", () => {
    for (const input of ["1.5", "1,5", "0", "-3", "+3", "721", "1e2", "abc"]) {
      assert.ok("error" in resolveAutoDeleteHours(false, input), input);
    }
  });
});

describe("autoDeleteConfirmLine", () => {
  it("names the hours or says the post stays", () => {
    assert.equal(autoDeleteConfirmLine(24), "This post will be deleted in 24 hours.");
    assert.equal(autoDeleteConfirmLine(1), "This post will be deleted in 1 hour.");
    assert.equal(autoDeleteConfirmLine(null), "This post will stay forever.");
  });
});
