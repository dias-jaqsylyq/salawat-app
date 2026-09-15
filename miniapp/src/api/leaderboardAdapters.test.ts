import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adminLeaderboardToMembers } from "./leaderboardAdapters.ts";
import type { AdminLeaderboardResponse } from "./types.ts";

/**
 * Regression coverage for the live-prod bug: an admin/co-admin saw no points
 * anywhere — not their own on the bottom-nav Leaderboard tab, not anyone's on
 * Admin → Leaderboard. Both screens are fed by GET /api/admin/leaderboard for
 * an admin caller, whose rows name the figure `totalPoints`; LeaderboardMemberRow
 * only ever reads `points`, so every row rendered as the "hidden" dash. The bug
 * was never in the server's serialization — it was this adapter being missing.
 */
describe("adminLeaderboardToMembers — the admin board, as LeaderboardMemberRow reads it", () => {
  it("carries every row's real points under `points`, admin's own row included", () => {
    const response: AdminLeaderboardResponse = {
      leaderboard: [
        {
          rank: 1,
          nickname: "room-owner",
          realName: "Owner Name",
          telegramId: 1001,
          totalPoints: 42,
          isRoomAdmin: true,
          isYou: true,
        },
        {
          rank: 2,
          nickname: "member-two",
          realName: "Member Two",
          telegramId: 1002,
          totalPoints: 17,
          isRoomAdmin: false,
          isYou: false,
        },
      ],
      period: "all-time",
      weekStart: "2026-09-07",
      weekEnd: "2026-09-13",
    };

    const { leaderboard, weekStart, weekEnd } = adminLeaderboardToMembers(response);

    assert.equal(weekStart, "2026-09-07");
    assert.equal(weekEnd, "2026-09-13");

    // The admin's own row must carry a real figure, not the `undefined` that
    // LeaderboardMemberRow renders as a hidden dash.
    const you = leaderboard.find((row) => row.isYou);
    assert.equal(you?.points, 42);

    // Unlike the member board, nobody's points are hidden from an admin.
    const other = leaderboard.find((row) => !row.isYou);
    assert.equal(other?.points, 17);

    for (const row of leaderboard) {
      assert.equal(
        "totalPoints" in row,
        false,
        `${row.nickname} still carries the raw wire field instead of the mapped one`
      );
    }
  });

  it("keeps the moderation detail the row and its actions need", () => {
    const response: AdminLeaderboardResponse = {
      leaderboard: [
        {
          rank: 1,
          nickname: "co-admin",
          realName: null,
          telegramId: 2002,
          totalPoints: 0,
          isRoomAdmin: true,
          isYou: false,
        },
      ],
      period: "weekly",
      weekStart: "2026-09-07",
      weekEnd: "2026-09-13",
    };

    const { leaderboard } = adminLeaderboardToMembers(response);
    const [row] = leaderboard;

    assert.equal(row?.telegramId, 2002);
    assert.equal(row?.isRoomAdmin, true);
    assert.equal(row?.realName, null);
    // A real 0 must survive as 0, never fall back to "hidden".
    assert.equal(row?.points, 0);
  });
});
