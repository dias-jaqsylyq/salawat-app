import type { Request, Response } from "express";
import {
  getHabitById,
  getPersonalHabitById,
  getRoomById,
  getUserByTelegramId,
} from "../db/repository.js";
import type { Habit, PersonalHabit, Room, User } from "../types.js";

/**
 * Room scoping for the HTTP API (MULTI ROOM PRD §3).
 *
 * The Mini App never passes a room identifier: every request is scoped to
 * whatever room the caller is currently in, resolved here from
 * `req.telegramId` -> `users.current_room_id`. Routes that read another row by
 * id (a habit, a member) must additionally check that row belongs to the same
 * room — `requireAdmin` only proves the caller is an admin of *their own* room,
 * never of the room the id happens to point at.
 */
export interface CallerRoom {
  user: User;
  room: Room;
  /** Convenience alias for `room.id` — the value every repository call takes. */
  roomId: number;
}

/**
 * The caller's room, or null when they are not registered or between rooms
 * (`current_room_id IS NULL`, PRD §3a). Read-only routes use this to answer
 * with an empty view rather than an error.
 */
export function resolveCallerRoom(req: Request): CallerRoom | null {
  const user = getUserByTelegramId(req.telegramId);
  if (!user || user.current_room_id === null) return null;
  const room = getRoomById(user.current_room_id);
  if (!room) return null;
  return { user, room, roomId: room.id };
}

/**
 * Same lookup for routes that write: answers the response itself and returns
 * null when there is no room to scope the write to. `no_room` is a 400 to match
 * the shape POST /api/admin/habits already established.
 */
export function requireCallerRoom(req: Request, res: Response): CallerRoom | null {
  const user = getUserByTelegramId(req.telegramId);
  if (!user) {
    res.status(403).json({ success: false, error: "not_registered" });
    return null;
  }
  const room = user.current_room_id === null ? undefined : getRoomById(user.current_room_id);
  if (!room) {
    res.status(400).json({ success: false, error: "no_room" });
    return null;
  }
  return { user, room, roomId: room.id };
}

/**
 * A habit of this room. A habit belonging to *another* room comes back
 * undefined, exactly like a habit id that does not exist — callers turn both
 * into the same 404, so the API never confirms that some other room's id is
 * real.
 */
export function getRoomHabit(habitId: number, roomId: number): Habit | undefined {
  const habit = getHabitById(habitId);
  return habit !== undefined && habit.room_id === roomId ? habit : undefined;
}

/**
 * One of the caller's *own* personal habits, in the room they are currently in.
 * Someone else's habit, one of their own from a room they have since left, and
 * a habit id that does not exist all come back undefined — callers turn all
 * three into the same 404, so the API never confirms another member has a
 * private habit at all.
 */
export function getOwnPersonalHabit(
  personalHabitId: number,
  userId: number,
  roomId: number
): PersonalHabit | undefined {
  const habit = getPersonalHabitById(personalHabitId);
  return habit !== undefined && habit.user_id === userId && habit.room_id === roomId
    ? habit
    : undefined;
}

/**
 * A current member of this room, by Telegram id. Someone in another room (or in
 * none) comes back undefined — this is what keeps kick/promote/demote from
 * reaching across rooms.
 */
export function getRoomMemberByTelegramId(
  telegramId: number,
  roomId: number
): User | undefined {
  const user = getUserByTelegramId(telegramId);
  return user !== undefined && user.current_room_id === roomId ? user : undefined;
}

/** The room shape returned to the Mini App (header, Settings, category grouping). */
export function roomResponse(room: Room): {
  id: number;
  name: string;
  categoriesEnabled: boolean;
} {
  return {
    id: room.id,
    name: room.name,
    categoriesEnabled: room.categories_enabled === 1,
  };
}
