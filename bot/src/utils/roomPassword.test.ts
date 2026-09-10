import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_ROOM_PASSWORD_LENGTH,
  MIN_ROOM_PASSWORD_LENGTH,
  generateRoomPassword,
  isValidRoomPassword,
} from "./roomPassword.js";

describe("isValidRoomPassword", () => {
  it("accepts a password at or above the minimum length", () => {
    assert.equal(isValidRoomPassword("abcdef"), true);
    assert.equal(isValidRoomPassword("Ramadan_2026-crew"), true);
  });

  it("rejects anything shorter than the minimum", () => {
    assert.equal(isValidRoomPassword("abcde"), false);
    assert.equal(isValidRoomPassword(""), false);
    assert.equal(MIN_ROOM_PASSWORD_LENGTH, 6);
  });

  it("rejects characters Telegram would not carry in a start payload", () => {
    // These would produce a t.me/<bot>?start=<password> link that silently
    // fails to hand the password back (PRD §3a).
    assert.equal(isValidRoomPassword("has space"), false);
    assert.equal(isValidRoomPassword("emoji🌙pass"), false);
    assert.equal(isValidRoomPassword("slash/pass"), false);
    assert.equal(isValidRoomPassword("плюс-кириллица"), false);
  });

  it("rejects a password longer than Telegram's start-payload ceiling", () => {
    assert.equal(isValidRoomPassword("a".repeat(MAX_ROOM_PASSWORD_LENGTH)), true);
    assert.equal(isValidRoomPassword("a".repeat(MAX_ROOM_PASSWORD_LENGTH + 1)), false);
  });

  it("is case-sensitive: it never normalizes what it is handed", () => {
    assert.equal(isValidRoomPassword("ABCDEF"), true);
    assert.equal(isValidRoomPassword("abcdef"), true);
  });
});

describe("generateRoomPassword", () => {
  it("generates passwords that pass validation", () => {
    for (let i = 0; i < 200; i++) {
      const password = generateRoomPassword();
      assert.equal(isValidRoomPassword(password), true, `invalid generated password: ${password}`);
    }
  });

  it("avoids characters that are ambiguous when read aloud", () => {
    for (let i = 0; i < 200; i++) {
      assert.doesNotMatch(generateRoomPassword(), /[0O1lI]/);
    }
  });

  it("does not repeat itself across a batch", () => {
    const generated = new Set(Array.from({ length: 200 }, () => generateRoomPassword()));
    assert.equal(generated.size, 200);
  });
});
