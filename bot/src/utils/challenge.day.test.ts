import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

process.env.BOT_TOKEN ??= "test-token";
process.env.CHALLENGE_START_DATE ??= "2026-08-01";
process.env.CHALLENGE_END_DATE ??= "2026-08-31";
process.env.TIMEZONE = "Asia/Hong_Kong";

describe("TIMEZONE day boundaries (Asia/Hong_Kong)", () => {
  let dayKeyFromSqliteUtc: typeof import("./challenge.js").dayKeyFromSqliteUtc;
  let getUtcRangeForDate: typeof import("./challenge.js").getUtcRangeForDate;
  let parseDateKey: typeof import("./challenge.js").parseDateKey;

  before(async () => {
    const mod = await import("./challenge.js");
    dayKeyFromSqliteUtc = mod.dayKeyFromSqliteUtc;
    getUtcRangeForDate = mod.getUtcRangeForDate;
    parseDateKey = mod.parseDateKey;
  });

  it("maps UTC timestamps just before/after HKT midnight to correct dates", () => {
    // HKT = UTC+8. 2026-08-11 00:00 HKT = 2026-08-10 16:00 UTC
    assert.equal(dayKeyFromSqliteUtc("2026-08-10 15:59:59", "Asia/Hong_Kong"), "2026-08-10");
    assert.equal(dayKeyFromSqliteUtc("2026-08-10 16:00:00", "Asia/Hong_Kong"), "2026-08-11");
    assert.equal(dayKeyFromSqliteUtc("2026-08-11 15:59:59", "Asia/Hong_Kong"), "2026-08-11");
    assert.equal(dayKeyFromSqliteUtc("2026-08-11 16:00:00", "Asia/Hong_Kong"), "2026-08-12");
  });

  it("getUtcRangeForDate returns HKT midnight as UTC bounds", () => {
    const { startUtc, endUtc } = getUtcRangeForDate(parseDateKey("2026-08-11"), "Asia/Hong_Kong");
    assert.equal(startUtc, "2026-08-10 16:00:00");
    assert.equal(endUtc, "2026-08-11 16:00:00");
  });
});
