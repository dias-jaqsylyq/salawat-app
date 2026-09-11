import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { NextFunction, Request, Response } from "express";

process.env.BOT_TOKEN ??= "rate-limit-test";
process.env.TIMEZONE ??= "Asia/Hong_Kong";
process.env.DB_PATH ??= ":memory:";

const {
  allowDailyCount,
  allowRequest,
  allowRequestFromIp,
  rateLimited,
  rateLimitedByIp,
  resetRateLimits,
} = await import("./rateLimit.js");

interface Captured {
  status?: number;
  body?: unknown;
  nextCalled: boolean;
}

function runMiddleware(
  middleware: (req: Request, res: Response, next: NextFunction) => void,
  req: Partial<Request>
): Captured {
  const captured: Captured = { nextCalled: false };
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
  } as unknown as Response;

  middleware(req as Request, res, () => {
    captured.nextCalled = true;
  });
  return captured;
}

beforeEach(() => {
  resetRateLimits();
});

describe("allowRequest", () => {
  it("allows exactly maxPerMinute attempts, then refuses", () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      assert.equal(allowRequest(1, 3, now), true, `attempt ${i + 1} should be allowed`);
    }
    assert.equal(allowRequest(1, 3, now), false);
  });

  it("frees the bucket once the rolling minute has passed", () => {
    const now = Date.now();
    assert.equal(allowRequest(2, 1, now), true);
    assert.equal(allowRequest(2, 1, now + 59_000), false);
    assert.equal(allowRequest(2, 1, now + 61_000), true);
  });

  it("keeps separate buckets per user", () => {
    const now = Date.now();
    assert.equal(allowRequest(3, 1, now), true);
    assert.equal(allowRequest(3, 1, now), false);
    assert.equal(allowRequest(4, 1, now), true);
  });
});

describe("allowRequestFromIp", () => {
  it("keeps separate buckets per address", () => {
    const now = Date.now();
    assert.equal(allowRequestFromIp("1.2.3.4", 1, now), true);
    assert.equal(allowRequestFromIp("1.2.3.4", 1, now), false);
    assert.equal(allowRequestFromIp("5.6.7.8", 1, now), true);
  });

  it("never collides with the per-user bucket of the same numeric value", () => {
    const now = Date.now();
    // A user id of 7 and an IP string of "7" must not share a bucket — they
    // would if the store were keyed by the raw value.
    assert.equal(allowRequest(7, 1, now), true);
    assert.equal(allowRequestFromIp("7", 1, now), true);
  });
});

describe("rateLimited middleware", () => {
  it("passes through under the limit and 429s over it", () => {
    const middleware = rateLimited(2);
    const req = { telegramId: 42 } as Partial<Request>;

    assert.equal(runMiddleware(middleware, req).nextCalled, true);
    assert.equal(runMiddleware(middleware, req).nextCalled, true);

    const blocked = runMiddleware(middleware, req);
    assert.equal(blocked.nextCalled, false);
    assert.equal(blocked.status, 429);
    assert.deepEqual(blocked.body, { success: false, error: "rate_limited" });
  });
});

describe("rateLimitedByIp middleware", () => {
  it("429s a single address over the limit without touching another", () => {
    const middleware = rateLimitedByIp(1);

    assert.equal(runMiddleware(middleware, { ip: "9.9.9.9" }).nextCalled, true);
    const blocked = runMiddleware(middleware, { ip: "9.9.9.9" });
    assert.equal(blocked.nextCalled, false);
    assert.equal(blocked.status, 429);

    assert.equal(runMiddleware(middleware, { ip: "8.8.8.8" }).nextCalled, true);
  });

  it("buckets requests with no resolvable address together rather than exempting them", () => {
    const middleware = rateLimitedByIp(1);
    assert.equal(runMiddleware(middleware, { ip: undefined }).nextCalled, true);
    assert.equal(runMiddleware(middleware, { ip: undefined }).nextCalled, false);
  });
});

describe("bucket sweeping", () => {
  it("does not hand back the daily salawat cap when an idle bucket is swept", () => {
    const now = Date.now();
    assert.equal(allowDailyCount(11, "2026-09-11", 100, 100), true);
    assert.equal(allowDailyCount(11, "2026-09-11", 1, 100), false);

    // Far enough ahead to trigger a sweep; the daily count must survive it,
    // otherwise the cap resets for free every time the process idles.
    allowRequest(999, 1, now + 60 * 60_000);
    assert.equal(allowDailyCount(11, "2026-09-11", 1, 100), false);
  });
});
