import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import type { Bot } from "grammy";
import { config } from "../config.js";
import type { MyContext } from "../context.js";
import { requireAdmin } from "./adminAuth.js";
import { telegramAuth } from "./authMiddleware.js";
import { registerRoute } from "./routes/register.js";
import { logRoute } from "./routes/log.js";
import { progressRoute } from "./routes/progress.js";
import { leaderboardRoute } from "./routes/leaderboard.js";
import { adminExportCsvRoute, exportRoute } from "./routes/export.js";
import { resetRoute } from "./routes/reset.js";
import { resetProgressRoute } from "./routes/resetProgress.js";
import { getProfileRoute, patchProfileRoute } from "./routes/profile.js";
import { putDayOverrideRoute } from "./routes/dayOverride.js";
import { adminStatsRoute, isAdminRoute } from "./routes/adminStatus.js";
import { adminLeaderboardRoute } from "./routes/adminLeaderboard.js";
import { createBroadcastRoute } from "./routes/broadcast.js";
import {
  adminPdfUpload,
  createBroadcastFileRoute,
} from "./routes/broadcastFile.js";

export function createApiServer(bot: Bot<MyContext>) {
  const app = express();

  const origin = config.corsOrigin === "*" ? "*" : config.corsOrigin.split(",").map((o) => o.trim());
  app.use(cors({ origin }));
  app.use(express.json({ limit: "16kb" }));

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.get("/api/admin/export", exportRoute);
  app.post("/api/admin/reset", resetRoute);

  app.post("/api/register", telegramAuth, registerRoute);
  app.post("/api/log", telegramAuth, logRoute);
  app.get("/api/progress", telegramAuth, progressRoute);
  app.put("/api/day-override", telegramAuth, putDayOverrideRoute);
  app.get("/api/leaderboard", telegramAuth, leaderboardRoute);
  app.get("/api/profile", telegramAuth, getProfileRoute);
  app.patch("/api/profile", telegramAuth, patchProfileRoute);
  app.post("/api/reset-progress", telegramAuth, resetProgressRoute);
  app.get("/api/is-admin", telegramAuth, isAdminRoute);
  app.get("/api/admin/stats", telegramAuth, requireAdmin, adminStatsRoute);
  app.get(
    "/api/admin/leaderboard",
    telegramAuth,
    requireAdmin,
    adminLeaderboardRoute
  );
  app.get(
    "/api/admin/export-csv",
    telegramAuth,
    requireAdmin,
    adminExportCsvRoute
  );
  app.post(
    "/api/admin/broadcast",
    telegramAuth,
    requireAdmin,
    createBroadcastRoute(bot)
  );
  app.post(
    "/api/admin/broadcast-file",
    telegramAuth,
    requireAdmin,
    adminPdfUpload,
    createBroadcastFileRoute(bot)
  );

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ success: false, error: "not_found" });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("API error:", err);
    res.status(500).json({ success: false, error: "internal_error" });
  });

  return app;
}
