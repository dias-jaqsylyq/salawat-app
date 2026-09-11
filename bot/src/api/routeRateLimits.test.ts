import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Bot } from "grammy";
import type { MyContext } from "../context.js";

process.env.BOT_TOKEN ??= "route-rate-limit-test";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH ??= ":memory:";

const { createApiServer } = await import("./server.js");

/** createApiServer only ever calls bot.api.* from inside a handler. */
const botStub = { api: {}, botInfo: { username: "test_habit_bot" } } as unknown as Bot<MyContext>;

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: { name: string }[];
  };
}

/** Every route the app mounts, as "METHOD /path" -> the middleware names in order. */
function routeMiddleware(): Map<string, string[]> {
  const app = createApiServer(botStub) as unknown as { router: { stack: RouteLayer[] } };
  const routes = new Map<string, string[]>();
  for (const layer of app.router.stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      routes.set(
        `${method.toUpperCase()} ${layer.route.path}`,
        layer.route.stack.map((handler) => handler.name)
      );
    }
  }
  return routes;
}

/**
 * Every state-changing or expensive-to-serve route, and which limiter it must
 * carry. This list is the point of the file: the original gap was not one
 * missing call but a convention nobody enforced, so routes added later simply
 * went unlimited. A new route here fails the test until it is either limited or
 * deliberately listed as exempt below.
 */
const MUST_BE_USER_LIMITED = [
  "POST /api/habits/:id/log",
  "DELETE /api/habits/:id/log",
  "PATCH /api/profile",
  "POST /api/room/leave",
  "POST /api/admin/habits",
  "PATCH /api/admin/habits/:id",
  "PATCH /api/admin/room",
  "POST /api/admin/room/password",
  "POST /api/admin/participants/:telegramId/admin",
  "DELETE /api/admin/participants/:telegramId/admin",
  "DELETE /api/admin/participants/:telegramId",
  "GET /api/admin/export-csv",
  "POST /api/admin/broadcast",
  "POST /api/admin/broadcast-file",
];

const MUST_BE_IP_LIMITED = ["GET /api/admin/export", "POST /api/admin/reset"];

/**
 * Routes that legitimately carry no limiter: reads that are cheap and serve the
 * app's own polling, plus the register stub that only ever answers 403.
 */
const UNLIMITED_BY_DESIGN = new Set([
  "GET /health",
  "POST /api/register",
  "GET /api/habits",
  "GET /api/progress",
  "GET /api/progress/week",
  "GET /api/leaderboard",
  "GET /api/profile",
  "GET /api/is-admin",
  "GET /api/admin/stats",
  "GET /api/admin/habits",
  "GET /api/admin/room",
  "GET /api/admin/leaderboard",
]);

/**
 * The two habit-log routes call allowRequest inside the handler rather than as
 * mounted middleware. Named so the check below accepts either shape.
 */
const IN_HANDLER_LIMITED = new Set([
  "POST /api/habits/:id/log",
  "DELETE /api/habits/:id/log",
  "PATCH /api/profile",
]);

describe("route rate-limit coverage", () => {
  const routes = routeMiddleware();

  it("mounts every sensitive route with a per-user limiter", () => {
    for (const route of MUST_BE_USER_LIMITED) {
      const middleware = routes.get(route);
      assert.ok(middleware, `${route} is not mounted at all`);
      const limited =
        middleware.includes("rateLimitMiddleware") || IN_HANDLER_LIMITED.has(route);
      assert.ok(limited, `${route} has no rate limiting: [${middleware.join(", ")}]`);
    }
  });

  it("mounts the secret-gated routes with a per-IP limiter", () => {
    for (const route of MUST_BE_IP_LIMITED) {
      const middleware = routes.get(route);
      assert.ok(middleware, `${route} is not mounted at all`);
      assert.ok(
        middleware.includes("ipRateLimitMiddleware"),
        `${route} has no per-IP rate limiting: [${middleware.join(", ")}]`
      );
    }
  });

  it("refuses a broadcast over the limit before multer buffers the upload", () => {
    const middleware = routes.get("POST /api/admin/broadcast-file")!;
    assert.ok(
      middleware.indexOf("rateLimitMiddleware") < middleware.indexOf("adminPdfUpload"),
      `the limiter must run before the 20 MB upload is buffered: [${middleware.join(", ")}]`
    );
  });

  it("leaves no route unaccounted for", () => {
    const accounted = new Set([
      ...MUST_BE_USER_LIMITED,
      ...MUST_BE_IP_LIMITED,
      ...UNLIMITED_BY_DESIGN,
    ]);
    const unaccounted = [...routes.keys()].filter((route) => !accounted.has(route));
    assert.deepEqual(
      unaccounted,
      [],
      `new route(s) added without a rate-limit decision: ${unaccounted.join(", ")}`
    );
  });
});
