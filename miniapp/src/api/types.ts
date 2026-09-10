export type HabitType = "quantity" | "binary";

export interface Habit {
  id: number;
  name: string;
  type: HabitType;
  pointsWeight: number;
}

export interface AdminHabit extends Habit {
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LogHabitResponse {
  success: true;
  habitId: number;
  value: number;
  points: number;
  logged: true;
}

export interface UnlogHabitResponse {
  success: true;
  habitId: number;
  logged: false;
}

export interface TodayHabitEntry {
  habitId: number;
  logged: boolean;
  value: number;
  points: number;
}

export interface HabitStreak {
  habitId: number;
  streak: number;
}

export type ProgressResponse = { registered: false } | RegisteredProgress;

export interface RegisteredProgress {
  registered: true;
  nickname: string;
  /** All-time points across every habit. */
  totalPoints: number;
  today: TodayHabitEntry[];
  streaks: HabitStreak[];
  /** True when the user is registered but has not provided a real name yet. */
  needsRealName: boolean;
}

export interface LeaderboardEntry {
  nickname: string;
  totalPoints: number;
  rank: number;
  /** Server-computed: true when this row is the authenticated viewer. */
  isYou: boolean;
}

export interface LeaderboardResponse {
  leaderboard: LeaderboardEntry[];
}

export interface ProfileResponse {
  nickname: string;
  realName: string | null;
  reminderEnabled: boolean;
  /** Effective HH:mm in server TIMEZONE. */
  reminderTime: string;
  /** IANA name (e.g. "Asia/Hong_Kong"), or null until the Mini App has set one. */
  timezone: string | null;
}

export interface ProfileUpdate {
  nickname?: string;
  realName?: string;
  reminderEnabled?: boolean;
  /** HH:mm, or null to clear override to the global default. */
  reminderTime?: string | null;
  /** IANA name, or null to clear back to the server default. */
  timezone?: string | null;
}

export interface AdminStatusResponse {
  isAdmin: boolean;
}

export interface AdminStatsResponse {
  participantCount: number;
}

export interface AdminLeaderboardEntry {
  rank: number;
  nickname: string;
  realName: string | null;
  telegramId: number;
  totalPoints: number;
}

export interface AdminLeaderboardResponse {
  leaderboard: AdminLeaderboardEntry[];
}

export type AdminBroadcastPayload =
  | { type: "text"; message: string }
  | { type: "link"; url: string; message?: string }
  | { type: "file"; fileUrl: string; message?: string };

export interface AdminBroadcastResponse {
  success: true;
  participantCount: number;
  sentCount: number;
  failedCount: number;
}
