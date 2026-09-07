import type {
  AdminBroadcastPayload,
  AdminBroadcastResponse,
  AdminLeaderboardResponse,
  AdminStatsResponse,
  AdminStatusResponse,
  DayOverrideResponse,
  LeaderboardResponse,
  LogResponse,
  LeaderboardPeriod,
  ProfileResponse,
  ProfileUpdate,
  ProgressResponse,
  ResetProgressResponse,
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

export function logSalawat(initData: string, count: number): Promise<LogResponse> {
  return request(initData, "/api/log", {
    method: "POST",
    body: JSON.stringify({ count }),
  });
}

export function getProgress(initData: string): Promise<ProgressResponse> {
  return request(initData, "/api/progress");
}

export function putDayOverride(
  initData: string,
  date: string,
  met: boolean
): Promise<DayOverrideResponse> {
  return request(initData, "/api/day-override", {
    method: "PUT",
    body: JSON.stringify({ date, met }),
  });
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

export function resetProgress(
  initData: string,
  dropFromJamaat: boolean = false
): Promise<ResetProgressResponse> {
  return request(initData, "/api/reset-progress", {
    method: "POST",
    body: JSON.stringify({ dropFromJamaat }),
  });
}

export function getIsAdmin(initData: string): Promise<AdminStatusResponse> {
  return request(initData, "/api/is-admin");
}

export function getAdminStats(initData: string): Promise<AdminStatsResponse> {
  return request(initData, "/api/admin/stats");
}

export function getAdminLeaderboard(
  initData: string,
  period: LeaderboardPeriod
): Promise<AdminLeaderboardResponse> {
  return request(initData, `/api/admin/leaderboard?period=${period}`);
}

export async function downloadAdminExport(
  initData: string,
  period: LeaderboardPeriod
): Promise<Blob> {
  const res = await fetch(`${BASE_URL}/api/admin/export-csv?period=${period}`, {
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
