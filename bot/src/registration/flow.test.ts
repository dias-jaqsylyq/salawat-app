import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MyContext } from "../context.js";

process.env.BOT_TOKEN ??= "flow-test";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH ??= ":memory:";

const { getPendingRegistration, getUserByTelegramId, ensurePendingRegistration } = await import(
  "../db/repository.js"
);
const { db } = await import("../db/client.js");
const { handleRegistrationAnswer } = await import("./flow.js");

/**
 * Approximates Telegram Bot API's real legacy-"Markdown" entity parser: a lone
 * unmatched _ or * anywhere in the text makes sendMessage reject with
 * "can't parse entities". A plain always-succeeds reply stub would hide this
 * class of bug entirely (free-text nicknames are never guaranteed balanced).
 */
function assertTelegramMarkdownParses(text: string): void {
  for (const marker of ["_", "*"]) {
    const count = text.split(marker).length - 1;
    if (count % 2 !== 0) {
      throw new Error(
        `Telegram 400: can't parse entities: Can't find end of the entity starting at byte offset ` +
          `${text.indexOf(marker)} (unmatched "${marker}")`
      );
    }
  }
}

function makeCtx(telegramId: number): {
  ctx: MyContext;
  replies: Array<{ text: string; opts: any }>;
} {
  const replies: Array<{ text: string; opts: any }> = [];
  const ctx = {
    from: { id: telegramId, is_bot: false, first_name: "Test", username: `user_${telegramId}` },
    reply: async (text: string, opts?: any) => {
      if (opts?.parse_mode === "Markdown") {
        assertTelegramMarkdownParses(text);
      }
      replies.push({ text, opts });
      return {} as any;
    },
  } as unknown as MyContext;
  return { ctx, replies };
}

let nextTelegramId = 950000001;
function makeTelegramId(): number {
  return nextTelegramId++;
}

describe("registration flow", () => {
  it("real_name -> nickname -> reminder_opt_in (yes) -> reminder_time creates a user with reminders on", async () => {
    const telegramId = makeTelegramId();
    const { ctx, replies } = makeCtx(telegramId);
    ensurePendingRegistration(telegramId);

    await handleRegistrationAnswer(ctx, getPendingRegistration(telegramId)!, "Ali Nurlanov");
    assert.equal(getPendingRegistration(telegramId)!.step, "nickname");

    await handleRegistrationAnswer(ctx, getPendingRegistration(telegramId)!, "Ali");
    assert.equal(getPendingRegistration(telegramId)!.step, "reminder_opt_in");

    await handleRegistrationAnswer(ctx, getPendingRegistration(telegramId)!, "Yes");
    assert.equal(getPendingRegistration(telegramId)!.step, "reminder_time");

    await handleRegistrationAnswer(ctx, getPendingRegistration(telegramId)!, "20:30");

    assert.equal(getPendingRegistration(telegramId), undefined);
    const user = getUserByTelegramId(telegramId)!;
    assert.equal(user.nickname, "Ali");
    assert.equal(user.real_name, "Ali Nurlanov");
    assert.equal(user.reminder_enabled, 1);
    assert.equal(user.reminder_time, "20:30");

    const last = replies.at(-1)!;
    assert.match(last.text, /Ali/);
  });

  it("declining reminders at reminder_opt_in finalizes immediately, skipping reminder_time", async () => {
    const telegramId = makeTelegramId();
    const { ctx } = makeCtx(telegramId);
    ensurePendingRegistration(telegramId);

    await handleRegistrationAnswer(ctx, getPendingRegistration(telegramId)!, "No Reminders Person");
    await handleRegistrationAnswer(ctx, getPendingRegistration(telegramId)!, "NoReminders");
    assert.equal(getPendingRegistration(telegramId)!.step, "reminder_opt_in");

    await handleRegistrationAnswer(ctx, getPendingRegistration(telegramId)!, "No");

    assert.equal(getPendingRegistration(telegramId), undefined);
    const user = getUserByTelegramId(telegramId)!;
    assert.equal(user.nickname, "NoReminders");
    assert.equal(user.reminder_enabled, 0);
  });

  it("rejects an empty real name without advancing the step", async () => {
    const telegramId = makeTelegramId();
    const { ctx, replies } = makeCtx(telegramId);
    ensurePendingRegistration(telegramId);

    await handleRegistrationAnswer(ctx, getPendingRegistration(telegramId)!, "   ");
    assert.equal(getPendingRegistration(telegramId)!.step, "real_name");
    assert.match(replies.at(-1)!.text, /full name/i);
  });

  it("rejects a nickname matching the real name and a taken nickname, without advancing", async () => {
    const telegramId = makeTelegramId();
    const { ctx, replies } = makeCtx(telegramId);
    ensurePendingRegistration(telegramId);
    await handleRegistrationAnswer(ctx, getPendingRegistration(telegramId)!, "Same Name");

    await handleRegistrationAnswer(ctx, getPendingRegistration(telegramId)!, "same name");
    assert.equal(getPendingRegistration(telegramId)!.step, "nickname");
    assert.match(replies.at(-1)!.text, /different from your full name/i);

    // Finish registering a first user so we can collide on their nickname.
    const otherId = makeTelegramId();
    const other = makeCtx(otherId);
    ensurePendingRegistration(otherId);
    await handleRegistrationAnswer(other.ctx, getPendingRegistration(otherId)!, "Someone Else");
    await handleRegistrationAnswer(other.ctx, getPendingRegistration(otherId)!, "TakenNick");
    await handleRegistrationAnswer(other.ctx, getPendingRegistration(otherId)!, "No");
    assert.equal(getUserByTelegramId(otherId)?.nickname, "TakenNick");

    await handleRegistrationAnswer(ctx, getPendingRegistration(telegramId)!, "TakenNick");
    assert.equal(getPendingRegistration(telegramId)!.step, "nickname");
    assert.match(replies.at(-1)!.text, /already taken/i);
  });

  it("rejects an invalid reminder time without finalizing", async () => {
    const telegramId = makeTelegramId();
    const { ctx, replies } = makeCtx(telegramId);
    ensurePendingRegistration(telegramId);
    await handleRegistrationAnswer(ctx, getPendingRegistration(telegramId)!, "Time Tester");
    await handleRegistrationAnswer(ctx, getPendingRegistration(telegramId)!, "TimeTester");
    await handleRegistrationAnswer(ctx, getPendingRegistration(telegramId)!, "Yes");
    assert.equal(getPendingRegistration(telegramId)!.step, "reminder_time");

    await handleRegistrationAnswer(ctx, getPendingRegistration(telegramId)!, "25:99");
    assert.equal(getPendingRegistration(telegramId)!.step, "reminder_time");
    assert.equal(getUserByTelegramId(telegramId), undefined);
    assert.match(replies.at(-1)!.text, /isn't valid/i);
  });

  it("finalizes with a nickname containing Markdown-special characters (e.g. an underscore)", async () => {
    // A plain "*nickname*" Markdown reply would 400 on this — see
    // assertTelegramMarkdownParses. The real fix sends HTML with an escaped
    // nickname instead, which this test exercises end to end.
    const telegramId = makeTelegramId();
    const { ctx, replies } = makeCtx(telegramId);
    ensurePendingRegistration(telegramId);

    await handleRegistrationAnswer(ctx, getPendingRegistration(telegramId)!, "Ali Nurlanov");
    await handleRegistrationAnswer(ctx, getPendingRegistration(telegramId)!, "ali_2005");
    await handleRegistrationAnswer(ctx, getPendingRegistration(telegramId)!, "Yes");
    await handleRegistrationAnswer(ctx, getPendingRegistration(telegramId)!, "20:00");

    assert.equal(getPendingRegistration(telegramId), undefined);
    assert.equal(getUserByTelegramId(telegramId)?.nickname, "ali_2005");

    const last = replies.at(-1)!;
    assert.equal(last.opts?.parse_mode, "HTML");
    assert.match(last.text, /ali_2005/);
  });

  it("reconciles instead of erroring when a users row already exists for this telegram_id " +
    "(the only constraint createUser's INSERT can violate), logging the real SQL error either way",
  async () => {
    const telegramId = makeTelegramId();
    // A stale/pre-existing users row for this telegram_id — the exact condition
    // reproduced for the live "Something went wrong finishing your signup" report
    // (a users row survived from before this signup attempt, so createUser's
    // INSERT hits UNIQUE(users.telegram_id) at finalize time).
    db.prepare("INSERT INTO users (telegram_id, nickname) VALUES (?, ?)").run(
      telegramId,
      "Collision"
    );

    const { ctx, replies } = makeCtx(telegramId);
    ensurePendingRegistration(telegramId);

    const originalConsoleError = console.error;
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      await handleRegistrationAnswer(ctx, getPendingRegistration(telegramId)!, "Collision Person");
      await handleRegistrationAnswer(ctx, getPendingRegistration(telegramId)!, "CollisionNick");
      await handleRegistrationAnswer(ctx, getPendingRegistration(telegramId)!, "Yes");
      await handleRegistrationAnswer(ctx, getPendingRegistration(telegramId)!, "20:00");
    } finally {
      console.error = originalConsoleError;
    }

    // The real SQL error and a diagnostic snapshot must be logged, not just
    // "something failed" — this is what makes the next occurrence diagnosable.
    const logged = errors.map((args) => args.map(String).join(" ")).join("\n");
    assert.match(logged, /finalizeRegistration/);
    assert.match(logged, /UNIQUE constraint failed: users\.telegram_id/);
    assert.match(logged, /users row already exists for this telegram_id\? true/);
    assert.match(logged, /nickname .* taken by someone else\? false/);

    // Self-healing: the stale collision means the account already exists, so
    // this isn't a scary failure — clean up the now-redundant pending row and
    // tell the user plainly, instead of "something went wrong".
    assert.equal(getPendingRegistration(telegramId), undefined);
    assert.match(replies.at(-1)!.text, /already registered/i);
  });
});
