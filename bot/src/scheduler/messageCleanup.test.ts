import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Bot } from "grammy";
import type { MyContext } from "../context.js";

process.env.BOT_TOKEN ??= "cleanup-scheduler-test";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH ??= ":memory:";

const { enqueueMessageDeletion, listDueMessageDeletions } = await import("../db/repository.js");
const { db } = await import("../db/client.js");
const { runDueMessageDeletions } = await import("./messageCleanup.js");

function mockBot(
  deleteMessage: (chatId: number, messageId: number) => Promise<void>
): Bot<MyContext> {
  return { api: { deleteMessage } } as unknown as Bot<MyContext>;
}

function queuedCount(): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM scheduled_message_deletions")
    .get() as { n: number };
  return row.n;
}

/** Move a queued row's deadline into the past, the way an hour of waiting would. */
function makeOverdue(chatId: number, messageId: number): void {
  db.prepare(
    `UPDATE scheduled_message_deletions SET delete_at = datetime('now', '-1 minute')
     WHERE chat_id = ? AND message_id = ?`
  ).run(chatId, messageId);
}

function clearQueue(): void {
  db.prepare("DELETE FROM scheduled_message_deletions").run();
}

describe("message deletion queue", () => {
  it("only reports rows whose deadline has passed", () => {
    clearQueue();
    enqueueMessageDeletion(111, 1, 60);
    enqueueMessageDeletion(111, 2, 60);
    assert.deepEqual(listDueMessageDeletions(10), []);

    makeOverdue(111, 2);
    const due = listDueMessageDeletions(10);
    assert.equal(due.length, 1);
    assert.equal(due[0]!.message_id, 2);
  });

  it("keeps the earlier deadline when the same message is queued twice", () => {
    clearQueue();
    enqueueMessageDeletion(222, 9, 60);
    makeOverdue(222, 9);
    enqueueMessageDeletion(222, 9, 60);
    assert.equal(queuedCount(), 1);
    assert.equal(listDueMessageDeletions(10).length, 1);
  });
});

describe("runDueMessageDeletions", () => {
  it("deletes overdue messages and clears them from the queue", async () => {
    clearQueue();
    enqueueMessageDeletion(333, 11, 60);
    enqueueMessageDeletion(333, 12, 60);
    makeOverdue(333, 11);
    makeOverdue(333, 12);

    const deleted: number[] = [];
    await runDueMessageDeletions(
      mockBot(async (_chatId, messageId) => {
        deleted.push(messageId);
      })
    );

    assert.deepEqual(deleted, [11, 12]);
    assert.equal(queuedCount(), 0);
  });

  it("leaves messages that are not due yet alone", async () => {
    clearQueue();
    enqueueMessageDeletion(444, 21, 60);

    const deleted: number[] = [];
    await runDueMessageDeletions(
      mockBot(async (_chatId, messageId) => {
        deleted.push(messageId);
      })
    );

    assert.deepEqual(deleted, []);
    assert.equal(queuedCount(), 1);
  });

  it("drops a row Telegram refuses instead of retrying it forever", async () => {
    clearQueue();
    enqueueMessageDeletion(555, 31, 60);
    enqueueMessageDeletion(555, 32, 60);
    makeOverdue(555, 31);
    makeOverdue(555, 32);

    const attempted: number[] = [];
    await runDueMessageDeletions(
      mockBot(async (_chatId, messageId) => {
        attempted.push(messageId);
        if (messageId === 31) throw new Error("Bad Request: message can't be deleted");
      })
    );

    // The refusal did not abort the batch, and neither row is still queued.
    assert.deepEqual(attempted, [31, 32]);
    assert.equal(queuedCount(), 0);
  });
});
