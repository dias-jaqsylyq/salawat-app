import type { Request, Response } from "express";
import { config } from "../../config.js";
import { getExportRows } from "../../db/repository.js";
import { formatDateParts, getTodayInTimezone } from "../../utils/challenge.js";
import { requireCallerRoom } from "../roomScope.js";

/**
 * Prize-time CSV export for the app owner. Auth: ?key= or X-Admin-Key header
 * matching ADMIN_EXPORT_SECRET. Not Telegram-auth'd — keep the secret off
 * shared machines.
 *
 * Deliberately NOT room-scoped: there is no calling user behind the secret and
 * therefore no "own room" to scope to. Cross-room visibility belongs to the app
 * owner via direct access, not to any in-product admin (PRD §3a). The in-app
 * export (adminExportCsvRoute) is the room-scoped one.
 */
export function exportRoute(req: Request, res: Response) {
  const secret = config.adminExportSecret;
  if (!secret) {
    res.status(503).json({ success: false, error: "export_disabled" });
    return;
  }

  const provided =
    (typeof req.query.key === "string" ? req.query.key : undefined) ??
    req.header("X-Admin-Key") ??
    "";
  if (provided !== secret) {
    res.status(401).json({ success: false, error: "unauthorized" });
    return;
  }

  sendCsv(res, undefined, "habit-tracker-leaderboard");
}

/**
 * GET /api/admin/export-csv — the caller's own room only. Telegram-initData +
 * requireAdmin auth is applied in server.ts.
 *
 * The room's name goes into the filename so an admin juggling exports can tell
 * files apart (PRD §3a).
 */
export function adminExportCsvRoute(req: Request, res: Response): void {
  const caller = requireCallerRoom(req, res);
  if (!caller) return;

  sendCsv(res, caller.roomId, `habit-tracker-${filenameRoomPart(caller.room.name, caller.roomId)}`);
}

/**
 * A room name reduced to something safe for a Content-Disposition filename.
 * ASCII-only on purpose: the header is latin1, and a Cyrillic or emoji room
 * name would otherwise arrive mangled — a room whose name has no ASCII left
 * falls back to its id, which is always unambiguous.
 */
export function filenameRoomPart(roomName: string, roomId: number): string {
  const cleaned = roomName
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .toLowerCase();
  return cleaned.length > 0 ? `${cleaned}-${roomId}` : `room-${roomId}`;
}

function sendCsv(res: Response, roomId: number | undefined, filenameStem: string): void {
  const csv = buildExportCsv(roomId);
  const today = formatDateParts(getTodayInTimezone(config.timezone));
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filenameStem}-${today}.csv"`);
  res.send(csv);
}

/** One room's rows, or — for the owner-only secret-gated export — every room's. */
export function buildExportCsv(roomId?: number): string {
  const rows = getExportRows(roomId);
  let rank = 1;
  const ranked = rows.map((row, i) => {
    if (i > 0 && row.total < rows[i - 1]!.total) {
      rank = i + 1;
    }
    return { ...row, rank };
  });

  const lines = [
    "rank,nickname,real_name,telegram_id,telegram_username,telegram_first_name,telegram_last_name,total_points",
    ...ranked.map(
      (r) =>
        `${r.rank},${csvEscape(r.nickname)},${csvEscape(r.real_name ?? "")},${r.telegram_id},${csvEscape(r.telegram_username ?? "")},${csvEscape(r.telegram_first_name ?? "")},${csvEscape(r.telegram_last_name ?? "")},${r.total}`
    ),
  ];

  return lines.join("\n") + "\n";
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
