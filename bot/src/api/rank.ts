/**
 * Competition ranking: rows already sorted by score descending get places where
 * equal scores share one and the next distinct score skips the places they used
 * up — 10, 8, 8, 5 ranks as 1, 2, 2, 4, never 1, 2, 2, 3.
 *
 * One definition rather than the four near-identical loops this replaces (the
 * public board, the admin board, the weekly board and the CSV export): a member
 * who is #2 on the leaderboard has to be #2 in the export of the same room, and
 * that is only structurally true while there is a single implementation.
 *
 * `rows` must already be in descending score order — that ordering belongs to
 * the SQL, and this only walks it.
 */
export function rankRows<T>(rows: T[], scoreOf: (row: T) => number): { row: T; rank: number }[] {
  let rank = 1;
  return rows.map((row, index) => {
    if (index > 0 && scoreOf(row) < scoreOf(rows[index - 1]!)) {
      rank = index + 1;
    }
    return { row, rank };
  });
}
