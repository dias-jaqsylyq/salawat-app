import type { Request, Response } from "express";
import { config } from "../../config.js";
import { resetAllChallengeData } from "../../db/repository.js";

/**
 * Wipe all challenge participants and their logs/overrides so everyone
 * re-registers. Auth: ?key= or X-Admin-Key matching ADMIN_EXPORT_SECRET.
 * Body must include `{ "confirm": "RESET" }` to avoid accidental wipes.
 */
export function resetRoute(req: Request, res: Response) {
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

  if (req.body?.confirm !== "RESET") {
    res.status(400).json({ success: false, error: "confirm_required" });
    return;
  }

  const counts = resetAllChallengeData();
  res.json({ success: true, deleted: counts });
}
