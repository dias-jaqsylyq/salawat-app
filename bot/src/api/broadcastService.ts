import {
  enqueueMessageDeletionAt,
  getAllUsers,
  toSqliteUtc,
} from "../db/repository.js";
import type { User } from "../types.js";

export interface BroadcastResult {
  participantCount: number;
  sentCount: number;
  failedCount: number;
  /** UTC 'YYYY-MM-DD HH:MM:SS' when every sent message is deleted; null = kept forever. */
  autoDeleteAt: string | null;
}

export interface BroadcastOptions {
  /** Delete every sent message this many hours after the broadcast starts. */
  autoDeleteAfterHours?: number;
}

/**
 * Returns the sent message id when the message can be auto-deleted; senders
 * that never auto-delete (PDFs) may return nothing.
 */
export type BroadcastSend = (user: User) => Promise<number | void>;

export class BroadcastInProgressError extends Error {
  constructor() {
    super("broadcast_in_progress");
  }
}

/**
 * Rooms broadcast independently: the lock is per room id, so one room's long
 * send never makes another room's admin wait (or see broadcast_in_progress for
 * something they have nothing to do with).
 */
const broadcastsInProgress = new Set<number>();

/**
 * Send sequentially to every registered participant. A per-user failure is
 * logged and counted without aborting the remainder of the broadcast.
 *
 * With `deleteAt`, each successfully sent message is queued for deletion at
 * that one shared deadline. A failed enqueue is logged but still counts as
 * sent — the recipient did get the message.
 */
export async function broadcastUsers(
  users: User[],
  send: BroadcastSend,
  deleteAt: string | null = null
): Promise<BroadcastResult> {
  let sentCount = 0;
  let failedCount = 0;
  for (const user of users) {
    let messageId: number | void;
    try {
      messageId = await send(user);
      sentCount += 1;
    } catch (err) {
      failedCount += 1;
      console.error(
        `Broadcast failed for user ${user.telegram_id} (${user.nickname}):`,
        err
      );
      continue;
    }
    if (deleteAt !== null && typeof messageId === "number") {
      try {
        enqueueMessageDeletionAt(user.telegram_id, messageId, deleteAt);
      } catch (err) {
        console.error(
          `Could not queue broadcast deletion for user ${user.telegram_id}:`,
          err
        );
      }
    }
  }
  return {
    participantCount: users.length,
    sentCount,
    failedCount,
    autoDeleteAt: deleteAt,
  };
}

/**
 * Send to the members of exactly one room. An admin's broadcast reaches their
 * own room and never another one (PRD §3a) — the room comes from the caller's
 * current_room_id, so there is no way to address someone else's room at all.
 *
 * The auto-delete deadline is fixed once, when the broadcast starts, so every
 * recipient's copy is deleted on the same cleanup tick.
 */
export async function broadcastToRoom(
  roomId: number,
  send: BroadcastSend,
  options: BroadcastOptions = {}
): Promise<BroadcastResult> {
  if (broadcastsInProgress.has(roomId)) throw new BroadcastInProgressError();
  broadcastsInProgress.add(roomId);

  const deleteAt =
    options.autoDeleteAfterHours === undefined
      ? null
      : toSqliteUtc(new Date(Date.now() + options.autoDeleteAfterHours * 3_600_000));
  const users = getAllUsers(roomId);
  try {
    return await broadcastUsers(users, send, deleteAt);
  } finally {
    broadcastsInProgress.delete(roomId);
  }
}
