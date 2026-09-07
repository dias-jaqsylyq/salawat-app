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

let broadcastInProgress = false;

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

export async function broadcastToAll(
  send: (user: User) => Promise<void>
): Promise<BroadcastResult> {
  if (broadcastInProgress) throw new BroadcastInProgressError();
  broadcastInProgress = true;

  const users = getAllUsers();
  try {
    return await broadcastUsers(users, send);
  } finally {
    broadcastInProgress = false;
  }
}
