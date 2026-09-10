import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Request, Response } from "express";
import type { Bot } from "grammy";
import type { MyContext } from "../../context.js";

process.env.BOT_TOKEN ??= "admin-participants-route-test";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH ??= ":memory:";

const {
  addRoomAdmin,
  createHabit,
  createRoom,
  createUser,
  getUserByTelegramId,
  getUserTotalPoints,
  isRoomAdmin,
  setUserCurrentRoom,
  upsertHabitLog,
} = await import("../../db/repository.js");
const { config } = await import("../../config.js");
const { formatDateParts, getTodayInTimezone } = await import("../../utils/challenge.js");
const {
  createKickParticipantRoute,
  demoteParticipantRoute,
  kickNotificationText,
  promoteParticipantRoute,
} = await import("./adminParticipants.js");
const { leaveRoomRoute } = await import("./room.js");

const TODAY = formatDateParts(getTodayInTimezone(config.timezone));

/** Records the DMs a kick sends, and can be told to fail like Telegram would. */
const sentMessages: { chatId: number; text: string }[] = [];
let sendShouldFail = false;
const bot = {
  api: {
    async sendMessage(chatId: number, text: string) {
      if (sendShouldFail) throw new Error("bot was blocked by the user");
      sentMessages.push({ chatId, text });
    },
  },
} as unknown as Bot<MyContext>;
const kickParticipantRoute = createKickParticipantRoute(bot);

function capture(): { res: Response; status: () => number; body: () => any } {
  let status = 200;
  let body: any;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(value: any) {
      body = value;
      return this;
    },
  } as unknown as Response;
  return { res, status: () => status, body: () => body };
}

function call(
  handler: (req: Request, res: Response) => void,
  callerTelegramId: number,
  targetTelegramId?: number | string
): { status: number; body: any } {
  const result = capture();
  handler(
    {
      telegramId: callerTelegramId,
      params: targetTelegramId === undefined ? {} : { telegramId: String(targetTelegramId) },
    } as unknown as Request,
    result.res
  );
  return { status: result.status(), body: result.body() };
}

async function callKick(
  callerTelegramId: number,
  targetTelegramId: number
): Promise<{ status: number; body: any }> {
  const result = capture();
  await kickParticipantRoute(
    {
      telegramId: callerTelegramId,
      params: { telegramId: String(targetTelegramId) },
    } as unknown as Request,
    result.res
  );
  return { status: result.status(), body: result.body() };
}

let nextTelegramId = 980000001;
let nextRoomSuffix = 1;

/** A fresh room with its owner-admin, one habit, and `memberCount` plain members. */
function makeRoom(memberCount = 1) {
  const suffix = nextRoomSuffix++;
  const owner = createUser(nextTelegramId++, `participants-owner-${suffix}`);
  const room = createRoom(`Participants room ${suffix}`, `participants-pass-${suffix}`, owner.id);
  setUserCurrentRoom(owner.id, room.id);

  const habit = createHabit(room.id, `Habit ${suffix}`, "quantity", 2);
  const members = Array.from({ length: memberCount }, (_, i) => {
    const member = createUser(nextTelegramId++, `participants-member-${suffix}-${i}`);
    setUserCurrentRoom(member.id, room.id);
    return member;
  });

  return { room, owner, habit, members };
}

describe("POST /api/admin/participants/:telegramId/admin", () => {
  it("promotes a member of the caller's room, idempotently", () => {
    const { room, owner, members } = makeRoom();
    const member = members[0]!;

    const first = call(promoteParticipantRoute, owner.telegram_id, member.telegram_id);
    assert.equal(first.status, 200);
    assert.equal(first.body.isRoomAdmin, true);
    assert.equal(isRoomAdmin(member.id, room.id), true);

    const again = call(promoteParticipantRoute, owner.telegram_id, member.telegram_id);
    assert.equal(again.status, 200);
    assert.equal(again.body.isRoomAdmin, true);
  });

  it("lets a promoted co-admin promote someone else — co-admins are equal", () => {
    const { room, owner, members } = makeRoom(2);
    const [coAdmin, other] = members as [typeof members[0], typeof members[0]];

    call(promoteParticipantRoute, owner.telegram_id, coAdmin.telegram_id);
    const { status } = call(promoteParticipantRoute, coAdmin.telegram_id, other.telegram_id);
    assert.equal(status, 200);
    assert.equal(isRoomAdmin(other.id, room.id), true);
  });

  it("404s for someone in another room", () => {
    const mine = makeRoom();
    const theirs = makeRoom();

    const { status, body } = call(
      promoteParticipantRoute,
      mine.owner.telegram_id,
      theirs.members[0]!.telegram_id
    );
    assert.equal(status, 404);
    assert.equal(body.error, "participant_not_found");
    assert.equal(isRoomAdmin(theirs.members[0]!.id, theirs.room.id), false);
  });

  it("400s for a malformed telegram id", () => {
    const { owner } = makeRoom();
    const { status, body } = call(promoteParticipantRoute, owner.telegram_id, "not-a-number");
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_telegram_id");
  });
});

describe("DELETE /api/admin/participants/:telegramId/admin", () => {
  it("lets any co-admin demote the room's original owner (PRD §3a)", () => {
    const { room, owner, members } = makeRoom();
    const coAdmin = members[0]!;
    addRoomAdmin(room.id, coAdmin.id);

    const { status, body } = call(demoteParticipantRoute, coAdmin.telegram_id, owner.telegram_id);
    assert.equal(status, 200);
    assert.equal(body.isRoomAdmin, false);
    assert.equal(isRoomAdmin(owner.id, room.id), false);
  });

  it("refuses to leave the room with no admins at all", () => {
    const { room, owner } = makeRoom();

    const { status, body } = call(demoteParticipantRoute, owner.telegram_id, owner.telegram_id);
    assert.equal(status, 409);
    assert.equal(body.error, "last_admin");
    assert.equal(isRoomAdmin(owner.id, room.id), true);
  });

  it("is a no-op 200 for a member who was never an admin", () => {
    const { owner, members } = makeRoom();
    const { status, body } = call(
      demoteParticipantRoute,
      owner.telegram_id,
      members[0]!.telegram_id
    );
    assert.equal(status, 200);
    assert.equal(body.isRoomAdmin, false);
  });
});

describe("DELETE /api/admin/participants/:telegramId", () => {
  it("deletes the member's data for this room and tells them", async () => {
    const { room, owner, habit, members } = makeRoom();
    const member = members[0]!;
    upsertHabitLog(member.id, habit.id, 10, TODAY);
    assert.equal(getUserTotalPoints(member.id, room.id), 20);
    sentMessages.length = 0;

    const { status, body } = await callKick(owner.telegram_id, member.telegram_id);
    assert.equal(status, 200);
    assert.equal(body.habitLogsDeleted, 1);
    // Destructive, unlike a voluntary leave (PRD §3a): nothing survives the kick.
    assert.equal(getUserTotalPoints(member.id, room.id), 0);
    assert.equal(getUserByTelegramId(member.telegram_id)?.current_room_id, null);
    assert.deepEqual(sentMessages, [
      { chatId: member.telegram_id, text: kickNotificationText(room.name) },
    ]);
  });

  it("leaves the kicked member's logs in other rooms alone", async () => {
    const first = makeRoom();
    const second = makeRoom();
    const wanderer = first.members[0]!;
    upsertHabitLog(wanderer.id, first.habit.id, 5, TODAY);

    setUserCurrentRoom(wanderer.id, second.room.id);
    upsertHabitLog(wanderer.id, second.habit.id, 3, TODAY);

    await callKick(second.owner.telegram_id, wanderer.telegram_id);
    assert.equal(getUserTotalPoints(wanderer.id, second.room.id), 0);
    assert.equal(getUserTotalPoints(wanderer.id, first.room.id), 10);
  });

  it("still completes when the DM cannot be delivered", async () => {
    const { owner, members } = makeRoom();
    const member = members[0]!;
    sendShouldFail = true;
    try {
      const { status, body } = await callKick(owner.telegram_id, member.telegram_id);
      assert.equal(status, 200);
      assert.equal(body.success, true);
    } finally {
      sendShouldFail = false;
    }
    assert.equal(getUserByTelegramId(member.telegram_id)?.current_room_id, null);
  });

  it("refuses to kick yourself", async () => {
    const { room, owner } = makeRoom();
    const { status, body } = await callKick(owner.telegram_id, owner.telegram_id);
    assert.equal(status, 400);
    assert.equal(body.error, "cannot_kick_self");
    assert.equal(getUserByTelegramId(owner.telegram_id)?.current_room_id, room.id);
  });

  it("404s for someone in another room", async () => {
    const mine = makeRoom();
    const theirs = makeRoom();

    const { status, body } = await callKick(
      mine.owner.telegram_id,
      theirs.members[0]!.telegram_id
    );
    assert.equal(status, 404);
    assert.equal(body.error, "participant_not_found");
    assert.equal(
      getUserByTelegramId(theirs.members[0]!.telegram_id)?.current_room_id,
      theirs.room.id
    );
  });

  it("refuses to kick the room's last admin, leaving it never admin-less", async () => {
    // requireAdmin already stops a plain member from reaching this route; the
    // guard below is the layer under it, so the handler is called directly.
    const { room, owner, members } = makeRoom();
    const member = members[0]!;

    const { status, body } = await callKick(member.telegram_id, owner.telegram_id);
    assert.equal(status, 409);
    assert.equal(body.error, "last_admin");
    assert.equal(isRoomAdmin(owner.id, room.id), true);
    assert.equal(getUserByTelegramId(owner.telegram_id)?.current_room_id, room.id);
  });

  it("refuses to kick yourself even as the only admin", async () => {
    const { room, owner } = makeRoom();
    const { status, body } = await callKick(owner.telegram_id, owner.telegram_id);
    assert.equal(status, 400);
    assert.equal(body.error, "cannot_kick_self");
    assert.equal(isRoomAdmin(owner.id, room.id), true);
  });
});

describe("POST /api/room/leave", () => {
  it("detaches membership but keeps the logs (PRD §1)", () => {
    const { room, habit, members } = makeRoom();
    const member = members[0]!;
    upsertHabitLog(member.id, habit.id, 4, TODAY);

    const { status, body } = call(leaveRoomRoute, member.telegram_id);
    assert.equal(status, 200);
    assert.equal(body.leftRoomId, room.id);
    assert.equal(getUserByTelegramId(member.telegram_id)?.current_room_id, null);
    // Unlike a kick, a voluntary leave deletes nothing.
    assert.equal(getUserTotalPoints(member.id, room.id), 8);
  });

  it("strips co-admin status on the way out (PRD §3a)", () => {
    const { room, owner, members } = makeRoom();
    const coAdmin = members[0]!;
    addRoomAdmin(room.id, coAdmin.id);

    const { status } = call(leaveRoomRoute, coAdmin.telegram_id);
    assert.equal(status, 200);
    assert.equal(isRoomAdmin(coAdmin.id, room.id), false);
    assert.equal(isRoomAdmin(owner.id, room.id), true);
  });

  it("refuses to let the room's last admin leave", () => {
    const { room, owner } = makeRoom();
    const { status, body } = call(leaveRoomRoute, owner.telegram_id);
    assert.equal(status, 409);
    assert.equal(body.error, "last_admin");
    assert.equal(getUserByTelegramId(owner.telegram_id)?.current_room_id, room.id);
  });

  it("400s for a user who is already between rooms", () => {
    const stray = createUser(nextTelegramId++, "already-roomless");
    const { status, body } = call(leaveRoomRoute, stray.telegram_id);
    assert.equal(status, 400);
    assert.equal(body.error, "no_room");
  });

  it("403s for an unregistered telegram id", () => {
    const { status, body } = call(leaveRoomRoute, 999_999_999);
    assert.equal(status, 403);
    assert.equal(body.error, "not_registered");
  });
});
