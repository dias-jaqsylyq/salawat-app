import type { Request, Response } from "express";
import { resetAllChallengeData } from "../../db/repository.js";
import { requireAdminSecret } from "../adminAuth.js";

/**
 * Wipe all challenge participants and their logs/overrides so everyone
 * re-registers. Auth: ?key= or X-Admin-Key matching ADMIN_EXPORT_SECRET.
 * Body must include `{ "confirm": "RESET" }` to avoid accidental wipes.
 */
export function resetRoute(req: Request, res: Response) {
  if (!requireAdminSecret(req, res)) return;

  if (req.body?.confirm !== "RESET") {
    res.status(400).json({ success: false, error: "confirm_required" });
    return;
  }

  const counts = resetAllChallengeData();
  res.json({ success: true, deleted: counts });
}
