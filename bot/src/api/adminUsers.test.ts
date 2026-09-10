import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.BOT_TOKEN ??= "test-token";
process.env.DB_PATH ??= ":memory:";

const {
  addRoomAdmin,
  createHabit,
  createRoom,
  createUser,
  deleteUserCompletely,
  ensurePendingRegistration,
  getPendingRegistration,
  getRoomById,
  getUserByNickname,
  getUserByTelegramId,
  getUserByTelegramUsername,
  isRoomAdmin,
  setUserCurrentRoom,
  updatePendingRegistration,
  upsertHabitLog,
} = await import("../db/repository.js");
const { isAdminTelegramId } = await import("./adminAuth.js");

describe("room-scoped admin status", () => {
  it("covers the room owner and anyone they promote, and nobody outside the room", () => {
    const owner = createUser(1225110756, "room-owner");
    const room = createRoom("Owner's room", "owner-room-pass", owner.id);
    setUserCurrentRoom(owner.id, room.id);
    assert.equal(isAdminTelegramId(1225110756), true);

    const participant = createUser(7171181415, "room-participant");
    setUserCurrentRoom(participant.id, room.id);
    assert.equal(isAdminTelegramId(7171181415), false);

    addRoomAdmin(room.id, participant.id);
    assert.equal(isAdminTelegramId(7171181415), true);

    // Co-admin status is per room: it does not follow them into another one.
    const otherOwner = createUser(910000010, "other-room-owner");
    const otherRoom = createRoom("Other room", "other-room-pass", otherOwner.id);
    setUserCurrentRoom(participant.id, otherRoom.id);
    assert.equal(isRoomAdmin(participant.id, room.id), false);
    assert.equal(isAdminTelegramId(7171181415), false);
  });
});

describe("deleteUserCompletely", () => {
  it("wipes user, habit logs, pending signup, and room-admin status", () => {
    const telegramId = 910000001;
    createUser(telegramId, "wipe-me", {
      telegramUsername: "wipe_me",
      telegramFirstName: "Wipe",
      telegramLastName: null,
    }, "Wipe Me");
    const user = getUserByTelegramId(telegramId)!;
    const room = createRoom("Wipe room", "wipe-room-pass", user.id);
    setUserCurrentRoom(user.id, room.id);
    const habit = createHabit(room.id, "Test habit", "quantity", 1);
    upsertHabitLog(user.id, habit.id, 25, "2026-08-01");
    assert.equal(isRoomAdmin(user.id, room.id), true);

    const result = deleteUserCompletely(telegramId);
    assert.equal(result.userDeleted, true);
    assert.equal(result.habitLogsDeleted, 1);
    assert.equal(result.roomAdminRowsDeleted, 1);
    assert.equal(getUserByTelegramId(telegramId), undefined);
    assert.equal(getUserByNickname("wipe-me"), undefined);
    assert.equal(getUserByTelegramUsername("wipe_me"), undefined);
    assert.equal(isRoomAdmin(user.id, room.id), false);
    assert.equal(getPendingRegistration(telegramId), undefined);

    // The room they created outlives them, with the owner reference cleared —
    // deleting a person never deletes a room out from under its members.
    assert.equal(getRoomById(room.id)?.owner_user_id, null);
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
