import type { Request, Response } from "express";
import { resetUserProgress } from "../../db/repository.js";

export function resetProgressRoute(req: Request, res: Response): void {
  const body = req.body ?? {};
  const hasDrop = Object.prototype.hasOwnProperty.call(body, "dropFromJamaat");
  if (hasDrop && typeof body.dropFromJamaat !== "boolean") {
    res.status(400).json({
      success: false,
      error: "invalid_drop_from_jamaat",
    });
    return;
  }

  const dropFromJamaat = body.dropFromJamaat ?? false;
  const result = resetUserProgress(req.telegramId, dropFromJamaat);
  if (!result) {
    res.status(403).json({ success: false, error: "not_registered" });
    return;
  }

  res.json({
    success: true,
    dropFromJamaat,
    total: 0,
    deleted: {
      logs: result.logsDeleted,
      dayGoalOverrides: result.dayGoalOverridesDeleted,
    },
  });
}
