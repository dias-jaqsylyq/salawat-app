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
process.env.ADMIN_TELEGRAM_ID ??= "1225110756";

const { parseAdminTelegramId } = await import("../config.js");
const { isAdminTelegramId, requireAdmin } = await import("./adminAuth.js");
const {
  adminMarkdownToTelegramHtml,
  validHttpUrl,
} = await import("./broadcastFormatting.js");
const { broadcastUsers } = await import("./broadcastService.js");
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
    goal: 100,
    reminder_enabled: 1,
    reminder_time: null,
    fasting_reminder_enabled: 0,
    fasting_reminder_time: "20:00",
    telegram_username: null,
    telegram_first_name: null,
    telegram_last_name: null,
    real_name: null,
    retained_jamaat_total: 0,
    progress_started_at: null,
    created_at: "2026-08-01 00:00:00",
  };
}

describe("admin Telegram authorization", () => {
  it("parses only positive safe integer ids", () => {
    assert.equal(parseAdminTelegramId("1225110756"), 1225110756);
    assert.equal(parseAdminTelegramId(""), null);
    assert.equal(parseAdminTelegramId("-1"), null);
    assert.equal(parseAdminTelegramId("abc"), null);
  });

  it("matches seeded env admin from the admins table", () => {
    assert.equal(isAdminTelegramId(1225110756), true);
    assert.equal(isAdminTelegramId(999000001), false);
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
