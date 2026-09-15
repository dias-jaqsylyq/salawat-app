import type { AdminLeaderboardResponse, LeaderboardMember } from "./types.ts";

/**
 * Normalizes GET /api/admin/leaderboard's wire shape into the LeaderboardMember
 * rows LeaderboardMemberRow renders.
 *
 * The two boards don't share a field name for the figure: the admin endpoint
 * names it `totalPoints` on every row, the member endpoint names it `points` on
 * the viewer's row alone. LeaderboardMemberRow only ever reads `points`, so an
 * admin response passed through unmapped renders no points at all — on the
 * bottom-nav Leaderboard tab and Admin → Leaderboard alike, since both are the
 * admin board for a caller with admin rights.
 */
export function adminLeaderboardToMembers(response: AdminLeaderboardResponse): {
  leaderboard: LeaderboardMember[];
  weekStart: string;
  weekEnd: string;
} {
  return {
    leaderboard: response.leaderboard.map(
      (entry): LeaderboardMember => ({
        rank: entry.rank,
        nickname: entry.nickname,
        isYou: entry.isYou,
        points: entry.totalPoints,
        realName: entry.realName,
        telegramId: entry.telegramId,
        isRoomAdmin: entry.isRoomAdmin,
      })
    ),
    weekStart: response.weekStart,
    weekEnd: response.weekEnd,
  };
}
