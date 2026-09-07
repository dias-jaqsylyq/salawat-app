import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.BOT_TOKEN ??= "test-token";
process.env.CHALLENGE_START_DATE ??= "2026-08-01";
process.env.CHALLENGE_END_DATE ??= "2026-09-01";
process.env.DB_PATH ??= ":memory:";
process.env.ADMIN_TELEGRAM_ID ??= "1225110756";

const {
  addAdmin,
  addLog,
  createUser,
  deleteUserCompletely,
  ensurePendingRegistration,
  getPendingRegistration,
  getUserByNickname,
  getUserByTelegramId,
  getUserByTelegramUsername,
  isAdmin,
  updatePendingRegistration,
} = await import("../db/repository.js");
const { isAdminTelegramId } = await import("./adminAuth.js");

describe("multi-admin table", () => {
  it("seeds ADMIN_TELEGRAM_ID and allows additional admins", () => {
    assert.equal(isAdmin(1225110756), true);
    assert.equal(isAdminTelegramId(1225110756), true);
    assert.equal(isAdminTelegramId(7171181415), false);

    addAdmin(7171181415);
    assert.equal(isAdminTelegramId(7171181415), true);
  });
});

describe("deleteUserCompletely", () => {
  it("wipes user, logs, pending signup, and admin row", () => {
    const telegramId = 910000001;
    createUser(telegramId, "wipe-me", 100, {
      telegramUsername: "wipe_me",
      telegramFirstName: "Wipe",
      telegramLastName: null,
    }, "Wipe Me");
    const user = getUserByTelegramId(telegramId)!;
    addLog(user.id, 25);
    addAdmin(telegramId);
    assert.equal(isAdmin(telegramId), true);

    const result = deleteUserCompletely(telegramId);
    assert.equal(result.userDeleted, true);
    assert.equal(result.logsDeleted, 1);
    assert.equal(getUserByTelegramId(telegramId), undefined);
    assert.equal(getUserByNickname("wipe-me"), undefined);
    assert.equal(getUserByTelegramUsername("wipe_me"), undefined);
    assert.equal(isAdmin(telegramId), false);
    assert.equal(getPendingRegistration(telegramId), undefined);
  });

  it("clears pending-only registrations so /start starts fresh", () => {
    const telegramId = 910000002;
    ensurePendingRegistration(telegramId);
    updatePendingRegistration(telegramId, {
      real_name: "Pending Person",
      step: "nickname",
    });
    assert.ok(getPendingRegistration(telegramId));

    const result = deleteUserCompletely(telegramId);
    assert.equal(result.pendingDeleted, true);
    assert.equal(getPendingRegistration(telegramId), undefined);

    const fresh = ensurePendingRegistration(telegramId);
    assert.equal(fresh.step, "real_name");
    assert.equal(fresh.real_name, null);
  });
});
