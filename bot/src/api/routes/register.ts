import type { Request, Response } from "express";

/**
 * Mini App registration is disabled — signup happens in the bot /start conversation.
 */
export function registerRoute(_req: Request, res: Response) {
  res.status(403).json({ success: false, error: "register_via_bot" });
}
