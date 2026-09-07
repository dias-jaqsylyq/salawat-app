import type { Request, Response } from "express";
import { getUserByTelegramId, upsertDayOverride } from "../../db/repository.js";
import { formatDateParts, parseDateKey, subtractOneCalendarDay } from "../../utils/challenge.js";
import { computeUserProgressFields } from "./progressFields.js";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function putDayOverrideRoute(req: Request, res: Response) {
  const user = getUserByTelegramId(req.telegramId);
  if (!user) {
    res.status(403).json({ success: false, error: "not_registered" });
    return;
  }

  const { date, met } = req.body ?? {};
  if (typeof date !== "string" || !DAY_RE.test(date)) {
    res.status(400).json({ success: false, error: "invalid_date" });
    return;
  }
  if (typeof met !== "boolean") {
    res.status(400).json({ success: false, error: "invalid_met" });
    return;
  }

  // Reject malformed calendar keys (e.g. 2026-02-31).
  const parts = parseDateKey(date);
  if (formatDateParts(parts) !== date) {
    res.status(400).json({ success: false, error: "invalid_date" });
    return;
  }

  const fields = computeUserProgressFields(user);
  const { todayKey, windowStartKey, earliestEligibleKey } = fields;

  // Today and future locked; only past days in the visible window.
  if (date >= todayKey || date < windowStartKey) {
    res.status(400).json({ success: false, error: "date_not_editable" });
    return;
  }

  // Days before the user registered are locked.
  if (date < earliestEligibleKey) {
    res.status(400).json({ success: false, error: "date_not_editable" });
    return;
  }

  // Extra guard: must be at least yesterday within window (today-6 .. today-1).
  const yesterdayKey = formatDateParts(subtractOneCalendarDay(fields.todayParts));
  if (date > yesterdayKey) {
    res.status(400).json({ success: false, error: "date_not_editable" });
    return;
  }

  upsertDayOverride(user.id, date, met);

  const updated = computeUserProgressFields(user);
  res.json({
    success: true,
    streak: updated.streak,
    last7Days: updated.last7Days,
  });
}
