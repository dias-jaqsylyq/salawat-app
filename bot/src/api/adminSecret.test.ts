import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.BOT_TOKEN ??= "admin-secret-test";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH ??= ":memory:";

const { secretsMatch } = await import("./adminAuth.js");

describe("secretsMatch", () => {
  it("accepts only the exact secret", () => {
    assert.equal(secretsMatch("s3cret", "s3cret"), true);
    assert.equal(secretsMatch("s3crer", "s3cret"), false);
    assert.equal(secretsMatch("S3CRET", "s3cret"), false);
    assert.equal(secretsMatch("", "s3cret"), false);
  });

  /**
   * timingSafeEqual throws on buffers of different lengths, so a naive
   * implementation needs a length check first — and that check is itself a
   * side channel. Hashing both sides makes the comparison length-independent;
   * these cases are what would crash a version that skipped it.
   */
  it("handles length mismatches without throwing", () => {
    assert.equal(secretsMatch("short", "a-much-longer-secret"), false);
    assert.equal(secretsMatch("a-much-longer-guess-than-the-secret", "short"), false);
    assert.equal(secretsMatch("", ""), true);
  });

  it("is not confused by multi-byte characters", () => {
    assert.equal(secretsMatch("пароль", "пароль"), true);
    assert.equal(secretsMatch("пароль", "парол"), false);
  });
});
