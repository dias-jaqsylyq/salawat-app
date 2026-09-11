import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import type { Bot } from "grammy";
import { config } from "../config.js";
import type { MyContext } from "../context.js";
import { requireAdmin } from "./adminAuth.js";
import { telegramAuth } from "./authMiddleware.js";
import { registerRoute } from "./routes/register.js";
import { deleteHabitLogRoute, listHabitsRoute, logHabitRoute } from "./routes/habits.js";
import { createHabitRoute, listAdminHabitsRoute, patchHabitRoute } from "./routes/adminHabits.js";
import { progressRoute } from "./routes/progress.js";
import { progressWeekRoute } from "./routes/progressWeek.js";
import { leaderboardRoute } from "./routes/leaderboard.js";
import { adminExportCsvRoute, exportRoute } from "./routes/export.js";
import { resetRoute } from "./routes/reset.js";
import { getProfileRoute, patchProfileRoute } from "./routes/profile.js";
import { adminStatsRoute, isAdminRoute } from "./routes/adminStatus.js";
import { adminLeaderboardRoute } from "./routes/adminLeaderboard.js";
import { createAdminRoomRoutes } from "./routes/adminRoom.js";
import {
  createKickParticipantRoute,
  demoteParticipantRoute,
  promoteParticipantRoute,
} from "./routes/adminParticipants.js";
import { leaveRoomRoute } from "./routes/room.js";
import { createBroadcastRoute } from "./routes/broadcast.js";
import {
  adminPdfUpload,
  createBroadcastFileRoute,
} from "./routes/broadcastFile.js";

export function createApiServer(bot: Bot<MyContext>) {
  const app = express();

  const { getAdminRoomRoute, patchAdminRoomRoute, regenerateRoomPasswordRoute } =
    createAdminRoomRoutes(bot);

  const origin = config.corsOrigin === "*" ? "*" : config.corsOrigin.split(",").map((o) => o.trim());
  app.use(cors({ origin }));
  app.use(express.json({ limit: "16kb" }));

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  // Owner-only, ADMIN_EXPORT_SECRET-gated, and deliberately NOT room-scoped:
  // there is no calling Telegram user behind the secret, so there is no "own
  // room" to scope to (MULTI ROOM PRD §3a). Everything below, by contrast, is
  // scoped to the caller's current room.
  app.get("/api/admin/export", exportRoute);
  app.post("/api/admin/reset", resetRoute);

  app.post("/api/register", telegramAuth, registerRoute);
  app.get("/api/habits", telegramAuth, listHabitsRoute);
  app.post("/api/habits/:id/log", telegramAuth, logHabitRoute);
  app.delete("/api/habits/:id/log", telegramAuth, deleteHabitLogRoute);
  app.get("/api/progress", telegramAuth, progressRoute);
  app.get("/api/progress/week", telegramAuth, progressWeekRoute);
  app.get("/api/leaderboard", telegramAuth, leaderboardRoute);
  app.get("/api/profile", telegramAuth, getProfileRoute);
  app.patch("/api/profile", telegramAuth, patchProfileRoute);
  app.post("/api/room/leave", telegramAuth, leaveRoomRoute);
  app.get("/api/is-admin", telegramAuth, isAdminRoute);
  app.get("/api/admin/stats", telegramAuth, requireAdmin, adminStatsRoute);
  app.get("/api/admin/habits", telegramAuth, requireAdmin, listAdminHabitsRoute);
  app.post("/api/admin/habits", telegramAuth, requireAdmin, createHabitRoute);
  app.patch("/api/admin/habits/:id", telegramAuth, requireAdmin, patchHabitRoute);
  app.get("/api/admin/room", telegramAuth, requireAdmin, getAdminRoomRoute);
  app.patch("/api/admin/room", telegramAuth, requireAdmin, patchAdminRoomRoute);
  app.post(
    "/api/admin/room/password",
    telegramAuth,
    requireAdmin,
    regenerateRoomPasswordRoute
  );
  app.post(
    "/api/admin/participants/:telegramId/admin",
    telegramAuth,
    requireAdmin,
    promoteParticipantRoute
  );
  app.delete(
    "/api/admin/participants/:telegramId/admin",
    telegramAuth,
    requireAdmin,
    demoteParticipantRoute
  );
  app.delete(
    "/api/admin/participants/:telegramId",
    telegramAuth,
    requireAdmin,
    createKickParticipantRoute(bot)
  );
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
