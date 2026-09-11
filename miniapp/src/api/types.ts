export type HabitType = "quantity" | "binary";

/**
 * Room-scoped habit category. Only meaningful while the room has categories
 * enabled — mirrors HabitCategory in salawat-bot.
 */
export type HabitCategory = "IQ" | "SQ" | "PQ" | "EQ";

/**
 * The caller's current room, as every room-aware response carries it. Null when
 * the user is registered but between rooms (MULTI ROOM PRD §3a) — they left one
 * and have not joined another in the bot yet.
 */
export interface Room {
  id: number;
  name: string;
  /** When true, every habit here carries a HabitCategory and the UI groups by it. */
  categoriesEnabled: boolean;
}

export interface Habit {
  id: number;
  name: string;
  type: HabitType;
  pointsWeight: number;
  /**
   * Echoed as stored: null in a categories-disabled room, and also null for a
   * habit created before the room turned categories on — the admin re-confirms
   * those rather than the server resurrecting stale values (PRD §0).
   */
  category: HabitCategory | null;
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

/**
 * Which shape the Progress screen draws streaks in. A saved Settings
 * preference, not a live toggle on Progress — and purely visual: switching it
 * recomputes nothing and caches nothing.
 */
export type StreakDisplay = "current" | "weekly";

/** One cell of the weekly view: a lit or unlit flame, never a count. */
export interface WeekDay {
  date: string;
  logged: boolean;
  /** Before this member joined the room — greyed out, not counted as missed. */
  locked: boolean;
  /** Later this week in the viewer's own timezone — likewise not a miss. */
  future: boolean;
}

export interface WeekHabitRow {
  habitId: number;
  name: string;
  /** Exactly 7, oldest → newest, aligned with WeeklyProgressResponse.days. */
  days: WeekDay[];
}

export interface WeeklyProgressResponse {
  weekStart: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekStartDay: number;
  today: string;
  /** The week's seven dates, for the weekday header. */
  days: string[];
  /** One row per active habit — flat, never grouped by category. */
  habits: WeekHabitRow[];
}

export type ProgressResponse = { registered: false } | RegisteredProgress;

export interface RegisteredProgress {
  registered: true;
  nickname: string;
  /** Null while the user is between rooms — everything else then reads as an empty day. */
  room: Room | null;
  /** All-time points across every habit of the current room. */
  totalPoints: number;
  /** Points earned today — the personal screen only; no group total exists. */
  todayPoints: number;
  today: TodayHabitEntry[];
  /** The day todayPoints covers, in the viewer's own timezone. */
  todayDate: string;
  streaks: HabitStreak[];
  /** Echoed from the profile so the screen picks a streak shape once. */
  streakDisplay: StreakDisplay;
  weekStartDay: number;
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

/**
 * One row of the Leaderboard screen, whichever endpoint filled it.
 *
 * Everyone sees the same screen; only the source differs. GET /api/leaderboard
 * gives participants nickname and points alone, while an admin's screen is fed
 * by GET /api/admin/leaderboard, which also carries the real name, the telegram
 * id the member actions address, and who holds co-admin. Those three are
 * optional here precisely because a participant's rows never have them — the
 * server does not send a member's real name to their room-mates.
 */
export interface LeaderboardMember {
  rank: number;
  nickname: string;
  totalPoints: number;
  isYou: boolean;
  realName?: string | null;
  telegramId?: number;
  isRoomAdmin?: boolean;
}

export interface ProfileResponse {
  nickname: string;
  realName: string | null;
  reminderEnabled: boolean;
  /** Effective HH:mm, fired in the user's own timezone. */
  reminderTime: string;
  /**
   * The Sunday/Wednesday fasting nudge, default off. Offered identically to
   * every member of every room, admins included — a function of the bot, not a
   * room setting.
   */
  fastingReminderEnabled: boolean;
  /** HH:mm; one time covers both fire days. */
  fastingReminderTime: string;
  streakDisplay: StreakDisplay;
  /** 0 = Sunday … 6 = Saturday. */
  weekStartDay: number;
  /** IANA name (e.g. "Asia/Hong_Kong"), or null until the Mini App has set one. */
  timezone: string | null;
  /** The room Settings names, and the one "Leave room" leaves. Null between rooms. */
  room: Room | null;
}

export interface ProfileUpdate {
  nickname?: string;
  realName?: string;
  reminderEnabled?: boolean;
  /** HH:mm, or null to clear override to the global default. */
  reminderTime?: string | null;
  fastingReminderEnabled?: boolean;
  /** HH:mm — not nullable: there is no global fasting default to fall back to. */
  fastingReminderTime?: string;
  streakDisplay?: StreakDisplay;
  weekStartDay?: number;
  /** IANA name, or null to clear back to the server default. */
  timezone?: string | null;
}

export interface LeaveRoomResponse {
  success: true;
  leftRoomId: number;
}

export interface AdminStatusResponse {
  isAdmin: boolean;
}

export interface AdminStatsResponse {
  participantCount: number;
}

/**
 * GET /api/admin/room — the admin's own room, password included. The password
 * is the room's invite code, deliberately absent from every participant-facing
 * response (PRD §3, §3a).
 */
export interface AdminRoomResponse extends Room {
  password: string;
  /** `t.me/<bot>?start=<password>`, or null before the bot knows its own username. */
  inviteLink: string | null;
  participantCount: number;
}

export interface AdminLeaderboardEntry {
  rank: number;
  nickname: string;
  realName: string | null;
  telegramId: number;
  totalPoints: number;
  /** Owner or co-admin of this room — all equal in power (PRD §3a). */
  isRoomAdmin: boolean;
  isYou: boolean;
}

export interface AdminLeaderboardResponse {
  leaderboard: AdminLeaderboardEntry[];
}

/** Response of promote/demote — the target's admin status after the change. */
export interface ParticipantAdminResponse {
  success: true;
  telegramId: number;
  nickname: string;
  isRoomAdmin: boolean;
}

export interface KickParticipantResponse {
  success: true;
  telegramId: number;
  nickname: string;
  /** Logs destroyed by the kick — a kick is destructive, unlike a voluntary leave. */
  habitLogsDeleted: number;
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
