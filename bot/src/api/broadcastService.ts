import { getAllUsers } from "../db/repository.js";
import type { User } from "../types.js";

export interface BroadcastResult {
  participantCount: number;
  sentCount: number;
  failedCount: number;
}

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
 */
export async function broadcastUsers(
  users: User[],
  send: (user: User) => Promise<void>
): Promise<BroadcastResult> {
  let sentCount = 0;
  let failedCount = 0;
  for (const user of users) {
    try {
      await send(user);
      sentCount += 1;
    } catch (err) {
      failedCount += 1;
      console.error(
        `Broadcast failed for user ${user.telegram_id} (${user.nickname}):`,
        err
      );
    }
  }
  return { participantCount: users.length, sentCount, failedCount };
}

/**
 * Send to the members of exactly one room. An admin's broadcast reaches their
 * own room and never another one (PRD §3a) — the room comes from the caller's
 * current_room_id, so there is no way to address someone else's room at all.
 */
export async function broadcastToRoom(
  roomId: number,
  send: (user: User) => Promise<void>
): Promise<BroadcastResult> {
  if (broadcastsInProgress.has(roomId)) throw new BroadcastInProgressError();
  broadcastsInProgress.add(roomId);

  const users = getAllUsers(roomId);
  try {
    return await broadcastUsers(users, send);
  } finally {
    broadcastsInProgress.delete(roomId);
  }
}
