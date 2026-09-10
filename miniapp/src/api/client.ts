import type {
  AdminBroadcastPayload,
  AdminBroadcastResponse,
  AdminHabit,
  AdminLeaderboardResponse,
  AdminRoomResponse,
  AdminStatsResponse,
  AdminStatusResponse,
  Habit,
  HabitCategory,
  HabitType,
  KickParticipantResponse,
  LeaderboardResponse,
  LeaveRoomResponse,
  LogHabitResponse,
  ParticipantAdminResponse,
  ProfileResponse,
  ProfileUpdate,
  ProgressResponse,
  UnlogHabitResponse,
} from "./types.ts";

const BASE_URL = import.meta.env.VITE_API_URL;

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string
  ) {
    super(`API error ${status}: ${code}`);
  }
}

async function request<T>(initData: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      Authorization: `tma ${initData}`,
    },
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, body?.error ?? "unknown_error");
  }
  return body as T;
}

async function multipartRequest<T>(
  initData: string,
  path: string,
  formData: FormData
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `tma ${initData}`,
    },
    body: formData,
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, body?.error ?? "unknown_error");
  }
  return body as T;
}

export function getHabits(initData: string): Promise<Habit[]> {
  return request(initData, "/api/habits");
}

/** POST /api/habits/:id/log — upsert today's value. Omit `value` for a binary habit. */
export function logHabit(
  initData: string,
  habitId: number,
  value?: number
): Promise<LogHabitResponse> {
  return request(initData, `/api/habits/${habitId}/log`, {
    method: "POST",
    body: JSON.stringify(value === undefined ? {} : { value }),
  });
}

/** DELETE /api/habits/:id/log — remove today's log, if any. Idempotent. */
export function deleteHabitLog(initData: string, habitId: number): Promise<UnlogHabitResponse> {
  return request(initData, `/api/habits/${habitId}/log`, { method: "DELETE" });
}

export function getProgress(initData: string): Promise<ProgressResponse> {
  return request(initData, "/api/progress");
}

export function getLeaderboard(initData: string): Promise<LeaderboardResponse> {
  return request(initData, "/api/leaderboard");
}

export function getProfile(initData: string): Promise<ProfileResponse> {
  return request(initData, "/api/profile");
}

export function patchProfile(initData: string, update: ProfileUpdate): Promise<ProfileResponse> {
  return request(initData, "/api/profile", {
    method: "PATCH",
    body: JSON.stringify(update),
  });
}

/**
 * POST /api/room/leave — leave the current room. Non-destructive: habit logs
 * stay in the database, membership and co-admin status are dropped. Refused
 * with `last_admin` for a room's last admin (PRD §3a). Joining another room
 * happens in the bot, with its password.
 */
export function leaveRoom(initData: string): Promise<LeaveRoomResponse> {
  return request(initData, "/api/room/leave", { method: "POST" });
}

export function getIsAdmin(initData: string): Promise<AdminStatusResponse> {
  return request(initData, "/api/is-admin");
}

export function getAdminStats(initData: string): Promise<AdminStatsResponse> {
  return request(initData, "/api/admin/stats");
}

export function getAdminHabits(initData: string): Promise<AdminHabit[]> {
  return request(initData, "/api/admin/habits");
}

/** `category` is required in a categories-enabled room and rejected in one without. */
export function createHabit(
  initData: string,
  habit: { name: string; type: HabitType; pointsWeight: number; category?: HabitCategory }
): Promise<AdminHabit> {
  return request(initData, "/api/admin/habits", {
    method: "POST",
    body: JSON.stringify(habit),
  });
}

export function patchHabit(
  initData: string,
  id: number,
  patch: { name?: string; pointsWeight?: number; isActive?: boolean; category?: HabitCategory }
): Promise<AdminHabit> {
  return request(initData, `/api/admin/habits/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

/** GET /api/admin/room — the caller's own room, password and invite link included. */
export function getAdminRoom(initData: string): Promise<AdminRoomResponse> {
  return request(initData, "/api/admin/room");
}

/** PATCH /api/admin/room — turn habit categories on or off for the room. */
export function patchAdminRoom(
  initData: string,
  update: { categoriesEnabled: boolean }
): Promise<AdminRoomResponse> {
  return request(initData, "/api/admin/room", {
    method: "PATCH",
    body: JSON.stringify(update),
  });
}

/**
 * POST /api/admin/room/password — set the room's join password. Pass one to
 * choose it, omit it for a generated replacement. Either way only *future*
 * joins are affected; current members keep their membership (PRD §3a).
 */
export function setRoomPassword(
  initData: string,
  password?: string
): Promise<AdminRoomResponse> {
  return request(initData, "/api/admin/room/password", {
    method: "POST",
    body: JSON.stringify(password === undefined ? {} : { password }),
  });
}

/** POST /api/admin/participants/:telegramId/admin — promote to co-admin. Idempotent. */
export function promoteParticipant(
  initData: string,
  telegramId: number
): Promise<ParticipantAdminResponse> {
  return request(initData, `/api/admin/participants/${telegramId}/admin`, {
    method: "POST",
  });
}

/** DELETE /api/admin/participants/:telegramId/admin — demote back to plain participant. */
export function demoteParticipant(
  initData: string,
  telegramId: number
): Promise<ParticipantAdminResponse> {
  return request(initData, `/api/admin/participants/${telegramId}/admin`, {
    method: "DELETE",
  });
}

/**
 * DELETE /api/admin/participants/:telegramId — kick a member out of the room.
 * Destructive: their logs for this room are deleted and the bot DMs them. They
 * may rejoin later with the password — a kick is not a ban (PRD §3a).
 */
export function kickParticipant(
  initData: string,
  telegramId: number
): Promise<KickParticipantResponse> {
  return request(initData, `/api/admin/participants/${telegramId}`, {
    method: "DELETE",
  });
}

export function getAdminLeaderboard(initData: string): Promise<AdminLeaderboardResponse> {
  return request(initData, "/api/admin/leaderboard");
}

export async function downloadAdminExport(initData: string): Promise<Blob> {
  const res = await fetch(`${BASE_URL}/api/admin/export-csv`, {
    headers: { Authorization: `tma ${initData}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, body?.error ?? "unknown_error");
  }
  return res.blob();
}

export function broadcastAdminContent(
  initData: string,
  payload: AdminBroadcastPayload
): Promise<AdminBroadcastResponse> {
  return request(initData, "/api/admin/broadcast", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function broadcastAdminPdf(
  initData: string,
  file: File,
  message?: string
): Promise<AdminBroadcastResponse> {
  const formData = new FormData();
  formData.append("file", file);
  if (message?.trim()) formData.append("message", message.trim());
  return multipartRequest(initData, "/api/admin/broadcast-file", formData);
}
