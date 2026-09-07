export type ChallengeStatus = "not_started" | "active" | "ended";

export interface ChallengeMeta {
  challengeStatus: ChallengeStatus;
  challengeStartDate: string;
  challengeEndDate: string;
}

export interface RegisterResponse {
  success: true;
  user: { id: number; nickname: string; goal: number };
}

export interface LogResponse {
  success: true;
  newTotal: number;
  /** Salawat logged today (challenge TIMEZONE day boundary), after this log. */
  newTodayTotal: number;
}

export type ProgressResponse =
  | ({ registered: false } & ChallengeMeta)
  | RegisteredProgress;

export interface DayBreakdown {
  /** YYYY-MM-DD in the challenge TIMEZONE. */
  date: string;
  total: number;
  metGoal: boolean;
  /**
   * True for days before the user registered.
   * Not missed and not makeup-eligible. Optional for older API responses.
   */
  locked?: boolean;
}

export interface DayOverrideResponse {
  success: true;
  streak: number;
  last7Days: DayBreakdown[];
}

export interface RegisteredProgress extends ChallengeMeta {
  registered: true;
  nickname: string;
  /** All-time salawat total. */
  total: number;
  /** Salawat logged today using the challenge TIMEZONE day boundary. */
  todayTotal: number;
  /** Daily salawat target (`users.goal` on the backend). */
  dailyGoal: number;
  /** Consecutive met days (TIMEZONE-aware; see backend streak rules). */
  streak: number;
  /** Past 7 days including today, oldest → newest. */
  last7Days: DayBreakdown[];
  daysLeft: number;
  /** True when the user is registered but has not provided a real name yet. */
  needsRealName: boolean;
}

export interface LeaderboardEntry {
  nickname: string;
  total: number;
  rank: number;
  /** Server-computed: true when this row is the authenticated viewer. */
  isYou: boolean;
}

export interface LeaderboardResponse {
  /** Sum of all registered users' all-time totals. */
  jamaatTotal: number;
  leaderboard: LeaderboardEntry[];
}

export interface ProfileResponse {
  nickname: string;
  dailyGoal: number;
  reminderEnabled: boolean;
  /** Effective HH:mm in challenge TIMEZONE. */
  reminderTime: string;
  fastingReminderEnabled?: boolean;
  /** HH:mm in challenge TIMEZONE. */
  fastingReminderTime?: string;
}

export interface ProfileUpdate {
  nickname?: string;
  dailyGoal?: number;
  reminderEnabled?: boolean;
  /** HH:mm, or null to clear override to the global default. */
  reminderTime?: string | null;
  /** Write-only; never returned from GET/PATCH /api/profile. */
  realName?: string;
  fastingReminderEnabled?: boolean;
  fastingReminderTime?: string;
}

export interface ResetProgressResponse {
  success: true;
  dropFromJamaat: boolean;
  total: 0;
  deleted: {
    logs: number;
    dayGoalOverrides: number;
  };
}

export interface AdminStatusResponse {
  isAdmin: boolean;
}

export interface AdminStatsResponse {
  participantCount: number;
  mawlidStartDate: string;
  mawlidEndDate: string;
}

export type LeaderboardPeriod = "all" | "mawlid";

export interface AdminLeaderboardEntry {
  rank: number;
  nickname: string;
  realName: string | null;
  total: number;
}

export interface AdminLeaderboardResponse {
  period: LeaderboardPeriod;
  periodStart?: string;
  periodEnd?: string;
  jamaatTotal: number;
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
