import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Request, Response } from "express";
import { InputFile, type Bot } from "grammy";
import type { MyContext } from "../context.js";
import type { User } from "../types.js";

process.env.BOT_TOKEN ??= "test-token";
process.env.CHALLENGE_START_DATE ??= "2026-08-01";
process.env.CHALLENGE_END_DATE ??= "2026-09-01";
process.env.DB_PATH ??= ":memory:";

const { isAdminTelegramId, requireAdmin } = await import("./adminAuth.js");
const { createRoom, createUser, setUserCurrentRoom } = await import("../db/repository.js");
const { db } = await import("../db/client.js");
const {
  adminMarkdownToTelegramHtml,
  parseAutoDeleteHours,
  validHttpUrl,
} = await import("./broadcastFormatting.js");
const { broadcastToRoom, broadcastUsers } = await import("./broadcastService.js");
const { createBroadcastRoute } = await import("./routes/broadcast.js");
const {
  createPdfSender,
  hasPdfSignature,
  safeFilename,
  telegramUploadFilename,
} = await import("./routes/broadcastFile.js");

function user(id: number): User {
  return {
    id,
    telegram_id: id,
    nickname: `user-${id}`,
    role: "participant",
    current_room_id: null,
    reminder_enabled: 1,
    reminder_time: "20:00",
    fasting_reminder_enabled: 0,
    fasting_reminder_time: "20:00",
    timezone: null,
    streak_display: "weekly",
    week_start_day: 1,
    room_joined_at: null,
    telegram_username: null,
    telegram_first_name: null,
    telegram_last_name: null,
    real_name: null,
    created_at: "2026-08-01 00:00:00",
  };
}

describe("admin Telegram authorization", () => {
  it("recognises an admin of the room the caller is currently in", () => {
    const owner = createUser(1225110756, "broadcast-room-owner");
    const room = createRoom("Broadcast room", "broadcast-room-pass", owner.id);
    setUserCurrentRoom(owner.id, room.id);

    assert.equal(isAdminTelegramId(1225110756), true);
    // A registered participant of the same room is not an admin of it, and an
    // unregistered id is not an admin of anything.
    const member = createUser(999000002, "broadcast-room-member");
    setUserCurrentRoom(member.id, room.id);
    assert.equal(isAdminTelegramId(999000002), false);
    assert.equal(isAdminTelegramId(999000001), false);
  });

  it("drops admin status when that admin leaves the room", () => {
    const owner = createUser(999000003, "leaving-owner");
    const room = createRoom("Leaving room", "leaving-room-pass", owner.id);
    setUserCurrentRoom(owner.id, room.id);
    assert.equal(isAdminTelegramId(999000003), true);

    setUserCurrentRoom(owner.id, null);
    assert.equal(isAdminTelegramId(999000003), false);
  });

  it("returns 403 for a non-admin", () => {
    let status = 200;
    let body: unknown;
    let nextCalled = false;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json(value: unknown) {
        body = value;
        return this;
      },
    } as unknown as Response;

    requireAdmin(
      { telegramId: 7171181415 } as Request,
      res,
      () => {
        nextCalled = true;
      }
    );

    assert.equal(status, 403);
    assert.deepEqual(body, { success: false, error: "not_admin" });
    assert.equal(nextCalled, false);
  });
});

describe("admin message formatting", () => {
  it("escapes raw HTML and converts bold/italic subset", () => {
    assert.equal(
      adminMarkdownToTelegramHtml("<b>raw</b> **bold** *italic* _also_"),
      "&lt;b&gt;raw&lt;/b&gt; <b>bold</b> <i>italic</i> <i>also</i>"
    );
  });

  it("accepts HTTP links and requires HTTPS for remote files", () => {
    assert.equal(validHttpUrl("https://youtu.be/example"), true);
    assert.equal(validHttpUrl("http://example.com"), true);
    assert.equal(validHttpUrl("http://example.com/file.pdf", true), false);
    assert.equal(validHttpUrl("https://example.com/file.pdf", true), true);
    assert.equal(validHttpUrl("javascript:alert(1)"), false);
  });
});

describe("error-tolerant broadcast loop", () => {
  it("continues after one recipient fails and reports counts", async () => {
    const attempted: number[] = [];
    const previousError = console.error;
    console.error = () => {};
    try {
      const result = await broadcastUsers(
        [user(1), user(2), user(3)],
        async (recipient) => {
          attempted.push(recipient.telegram_id);
          if (recipient.telegram_id === 2) throw new Error("blocked");
        }
      );
      assert.deepEqual(attempted, [1, 2, 3]);
      assert.deepEqual(result, {
        participantCount: 3,
        sentCount: 2,
        failedCount: 1,
        autoDeleteAt: null,
      });
    } finally {
      console.error = previousError;
    }
  });
});

describe("room-scoped broadcast", () => {
  it("reaches the caller's own room only (PRD §3a)", async () => {
    const mineOwner = createUser(999000010, "mine-broadcast-owner");
    const mine = createRoom("Mine", "mine-broadcast-pass", mineOwner.id);
    setUserCurrentRoom(mineOwner.id, mine.id);
    const mineMember = createUser(999000011, "mine-broadcast-member");
    setUserCurrentRoom(mineMember.id, mine.id);

    const theirsOwner = createUser(999000012, "theirs-broadcast-owner");
    const theirs = createRoom("Theirs", "theirs-broadcast-pass", theirsOwner.id);
    setUserCurrentRoom(theirsOwner.id, theirs.id);

    const reached: number[] = [];
    const result = await broadcastToRoom(mine.id, async (recipient) => {
      reached.push(recipient.telegram_id);
    });

    assert.deepEqual(reached.sort(), [999000010, 999000011]);
    assert.equal(result.participantCount, 2);
    assert.equal(result.sentCount, 2);
  });

  it("locks per room, so one room's send never blocks another's", async () => {
    const firstOwner = createUser(999000020, "lock-owner-a");
    const first = createRoom("Lock A", "lock-a-pass", firstOwner.id);
    setUserCurrentRoom(firstOwner.id, first.id);

    const secondOwner = createUser(999000021, "lock-owner-b");
    const second = createRoom("Lock B", "lock-b-pass", secondOwner.id);
    setUserCurrentRoom(secondOwner.id, second.id);

    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const slow = broadcastToRoom(first.id, async () => {
      await blocked;
    });

    // The other room goes through while the first is still in flight...
    const other = await broadcastToRoom(second.id, async () => {});
    assert.equal(other.sentCount, 1);

    // ...but a second send into the same room is refused.
    await assert.rejects(
      broadcastToRoom(first.id, async () => {}),
      (err: Error) => err.message === "broadcast_in_progress"
    );

    release();
    await slow;

    // The lock is released once it finishes.
    const after = await broadcastToRoom(first.id, async () => {});
    assert.equal(after.sentCount, 1);
  });
});

describe("PDF broadcast", () => {
  it("validates PDF magic bytes", () => {
    assert.equal(hasPdfSignature(Buffer.from("%PDF-1.7\n")), true);
    assert.equal(hasPdfSignature(Buffer.from("not a pdf")), false);
  });

  it("uploads once then reuses Telegram file_id", async () => {
    const documents: unknown[] = [];
    const bot = {
      api: {
        async sendDocument(_chatId: number, document: unknown) {
          documents.push(document);
          return { document: { file_id: "telegram-file-id" } };
        },
      },
    } as unknown as Bot<MyContext>;

    const send = createPdfSender(
      bot,
      Buffer.from("%PDF-1.7\ncontent"),
      "Monday Fast.pdf"
    );
    await send(user(1));
    await send(user(2));

    assert.equal(documents[0] instanceof InputFile, true);
    assert.equal((documents[0] as InputFile).filename, '"Monday Fast.pdf"');
    assert.equal(documents[1], "telegram-file-id");
  });

  it("keeps spaces and non-ASCII letters in the upload name", () => {
    assert.equal(safeFilename("Monday Fast.pdf"), "Monday Fast.pdf");
    assert.equal(safeFilename("Салауат.pdf"), "Салауат.pdf");
    assert.equal(safeFilename("Imam's notes.pdf"), "Imam's notes.pdf");
    assert.equal(safeFilename("C:\\\\Users\\\\Dias\\\\Monday Fast.pdf"), "Monday Fast.pdf");
    assert.equal(telegramUploadFilename("Monday Fast.pdf"), '"Monday Fast.pdf"');
  });
});

function queuedDeletions(): { chat_id: number; message_id: number; delete_at: string }[] {
  return db
    .prepare(
      "SELECT chat_id, message_id, delete_at FROM scheduled_message_deletions ORDER BY chat_id"
    )
    .all() as { chat_id: number; message_id: number; delete_at: string }[];
}

function clearDeletions(): void {
  db.prepare("DELETE FROM scheduled_message_deletions").run();
}

let nextRoomSeq = 0;

/** A room with an owner and one member; returns the owner's telegram id. */
function roomWithTwoMembers(): { ownerTelegramId: number; memberTelegramId: number } {
  nextRoomSeq += 1;
  const ownerTelegramId = 999100000 + nextRoomSeq * 10;
  const memberTelegramId = ownerTelegramId + 1;
  const owner = createUser(ownerTelegramId, `auto-delete-owner-${nextRoomSeq}`);
  const room = createRoom(
    `Auto delete ${nextRoomSeq}`,
    `auto-delete-pass-${nextRoomSeq}`,
    owner.id
  );
  setUserCurrentRoom(owner.id, room.id);
  const member = createUser(memberTelegramId, `auto-delete-member-${nextRoomSeq}`);
  setUserCurrentRoom(member.id, room.id);
  return { ownerTelegramId, memberTelegramId };
}

async function callBroadcastRoute(
  callerTelegramId: number,
  body: unknown
): Promise<{ status: number; body: any; sentTo: number[] }> {
  const sentTo: number[] = [];
  let messageId = 500;
  const bot = {
    api: {
      async sendMessage(chatId: number) {
        sentTo.push(chatId);
        messageId += 1;
        return { message_id: messageId };
      },
      async sendDocument(chatId: number) {
        sentTo.push(chatId);
        return { message_id: 0 };
      },
    },
  } as unknown as Bot<MyContext>;

  let status = 200;
  let responseBody: unknown;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(value: unknown) {
      responseBody = value;
      return this;
    },
  } as unknown as Response;

  await createBroadcastRoute(bot)(
    { telegramId: callerTelegramId, body } as unknown as Request,
    res
  );
  return { status, body: responseBody, sentTo };
}

describe("broadcast auto-delete timer", () => {
  it("parses the requested hours", () => {
    assert.deepEqual(parseAutoDeleteHours(undefined), { ok: true, hours: 24 });
    assert.deepEqual(parseAutoDeleteHours(null), { ok: true, hours: null });
    assert.deepEqual(parseAutoDeleteHours(1), { ok: true, hours: 1 });
    assert.deepEqual(parseAutoDeleteHours(720), { ok: true, hours: 720 });
    for (const bad of [0, -1, 721, 1.5, "24", Number.NaN, true]) {
      assert.deepEqual(parseAutoDeleteHours(bad), { ok: false }, String(bad));
    }
  });

  it("queues every sent message with one deadline fixed at broadcast start", async () => {
    clearDeletions();
    const { ownerTelegramId, memberTelegramId } = roomWithTwoMembers();
    const caller = createUser(ownerTelegramId + 2, "slow-send-member");
    const room = db
      .prepare("SELECT current_room_id AS id FROM users WHERE telegram_id = ?")
      .get(ownerTelegramId) as { id: number };
    setUserCurrentRoom(caller.id, room.id);

    const realNow = Date.now;
    const previousError = console.error;
    console.error = () => {};
    let clock = Date.parse("2026-09-26T10:00:00Z");
    Date.now = () => clock;
    try {
      let messageId = 0;
      const result = await broadcastToRoom(
        room.id,
        async (recipient) => {
          // Each send takes ten simulated minutes; the deadline must not move.
          clock += 10 * 60_000;
          if (recipient.telegram_id === ownerTelegramId + 2) throw new Error("blocked");
          messageId += 1;
          return messageId;
        },
        { autoDeleteAfterHours: 3 }
      );

      assert.equal(result.autoDeleteAt, "2026-09-26 13:00:00");
      assert.equal(result.sentCount, 2);
      assert.equal(result.failedCount, 1);
    } finally {
      Date.now = realNow;
      console.error = previousError;
    }

    const rows = queuedDeletions();
    // The failed recipient is not queued; both delivered copies share one deadline.
    assert.deepEqual(
      rows.map((row) => row.chat_id),
      [ownerTelegramId, memberTelegramId]
    );
    assert.deepEqual(
      rows.map((row) => row.delete_at),
      ["2026-09-26 13:00:00", "2026-09-26 13:00:00"]
    );
  });

  it("defaults a text post to 24 hours", async () => {
    clearDeletions();
    const { ownerTelegramId } = roomWithTwoMembers();
    const before = Date.now();
    const response = await callBroadcastRoute(ownerTelegramId, {
      type: "text",
      message: "Salawat",
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.sentCount, 2);
    const rows = queuedDeletions();
    assert.equal(rows.length, 2);
    const deadline = Date.parse(`${rows[0].delete_at.replace(" ", "T")}Z`);
    const expected = before + 24 * 3_600_000;
    assert.ok(Math.abs(deadline - expected) < 5_000, rows[0].delete_at);
    assert.equal(response.body.autoDeleteAt, rows[0].delete_at);
  });

  it("keeps a post forever when autoDeleteHours is null", async () => {
    clearDeletions();
    const { ownerTelegramId } = roomWithTwoMembers();
    const response = await callBroadcastRoute(ownerTelegramId, {
      type: "text",
      message: "Forever",
      autoDeleteHours: null,
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.autoDeleteAt, null);
    assert.equal(queuedDeletions().length, 0);
  });

  it("applies the timer to link posts too", async () => {
    clearDeletions();
    const { ownerTelegramId } = roomWithTwoMembers();
    const response = await callBroadcastRoute(ownerTelegramId, {
      type: "link",
      url: "https://youtu.be/example",
      autoDeleteHours: 5,
    });

    assert.equal(response.status, 200);
    assert.equal(queuedDeletions().length, 2);
  });

  it("rejects a timer on file broadcasts and never queues them", async () => {
    clearDeletions();
    const { ownerTelegramId } = roomWithTwoMembers();
    const rejected = await callBroadcastRoute(ownerTelegramId, {
      type: "file",
      fileUrl: "https://example.com/file.pdf",
      autoDeleteHours: 5,
    });
    assert.equal(rejected.status, 400);
    assert.deepEqual(rejected.body, { success: false, error: "invalid_auto_delete" });
    assert.deepEqual(rejected.sentTo, []);

    const kept = await callBroadcastRoute(ownerTelegramId, {
      type: "file",
      fileUrl: "https://example.com/file.pdf",
    });
    assert.equal(kept.status, 200);
    assert.equal(kept.body.autoDeleteAt, null);
    assert.equal(queuedDeletions().length, 0);
  });

  it("rejects an out-of-range or fractional timer before sending", async () => {
    const { ownerTelegramId } = roomWithTwoMembers();
    for (const hours of [0, 721, 1.5]) {
      const response = await callBroadcastRoute(ownerTelegramId, {
        type: "text",
        message: "Nope",
        autoDeleteHours: hours,
      });
      assert.equal(response.status, 400, String(hours));
      assert.deepEqual(response.sentTo, []);
    }
  });
});
