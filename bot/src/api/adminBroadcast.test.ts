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
const {
  adminMarkdownToTelegramHtml,
  validHttpUrl,
} = await import("./broadcastFormatting.js");
const { broadcastToRoom, broadcastUsers } = await import("./broadcastService.js");
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
