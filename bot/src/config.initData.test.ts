import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Loaded as a production config on purpose: the whole point of this file is
// that a deployment which forgets INIT_DATA_MAX_AGE_SECONDS still gets a 1h
// replay window rather than silently falling back to 24h.
process.env.NODE_ENV = "production";
process.env.BOT_TOKEN ??= "config-init-data-test";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH ??= ":memory:";
process.env.CORS_ORIGIN = "https://example.invalid";
delete process.env.INIT_DATA_MAX_AGE_SECONDS;

const { config, parseInitDataMaxAge } = await import("./config.js");

describe("parseInitDataMaxAge", () => {
  it("defaults to one hour in production when the variable is unset", () => {
    assert.equal(config.initDataMaxAgeSeconds, 3_600);
    assert.equal(parseInitDataMaxAge(undefined), 3_600);
    assert.equal(parseInitDataMaxAge(""), 3_600);
    assert.equal(parseInitDataMaxAge("   "), 3_600);
  });

  it("takes an explicit positive value", () => {
    assert.equal(parseInitDataMaxAge("3600"), 3_600);
    assert.equal(parseInitDataMaxAge("86400"), 86_400);
  });

  /**
   * `Number(raw) || default` used to swallow all of these: a typo, a unit
   * suffix, or a zero each resolved to the default without a word, which is
   * exactly how a deployment ends up running a window nobody picked.
   */
  it("throws on a value that is present but unusable, rather than falling back", () => {
    for (const raw of ["abc", "0", "-1", "3600s", "1.5", "NaN", "Infinity"]) {
      assert.throws(
        () => parseInitDataMaxAge(raw),
        /Invalid INIT_DATA_MAX_AGE_SECONDS/,
        `"${raw}" should be rejected, not silently defaulted`
      );
    }
  });
});
