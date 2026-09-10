import type { Request, Response } from "express";
import { config } from "../../config.js";
import { getExportRows } from "../../db/repository.js";
import { formatDateParts, getTodayInTimezone } from "../../utils/challenge.js";

/**
 * Prize-time CSV export. Auth: ?key= or X-Admin-Key header matching ADMIN_EXPORT_SECRET.
 * Not Telegram-auth'd — keep the secret off shared machines.
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

  sendCsv(res);
}

/** Telegram-initData + requireAdmin auth is applied in server.ts. */
export function adminExportCsvRoute(_req: Request, res: Response): void {
  sendCsv(res);
}

function sendCsv(res: Response): void {
  const csv = buildExportCsv();
  const today = formatDateParts(getTodayInTimezone(config.timezone));
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="habit-tracker-leaderboard-${today}.csv"`
  );
  res.send(csv);
}

export function buildExportCsv(): string {
  const rows = getExportRows();
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
