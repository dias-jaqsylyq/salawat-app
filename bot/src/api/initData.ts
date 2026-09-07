import { createHmac, timingSafeEqual } from "node:crypto";
import type { TelegramProfile } from "../types.js";

export class InitDataError extends Error {}

export interface ValidatedInitData extends TelegramProfile {
  telegramId: number;
}

interface TelegramUserField {
  id: number;
  username?: unknown;
  first_name?: unknown;
  last_name?: unknown;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Validates a Telegram Mini App `initData` string per Telegram's documented
 * algorithm (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app).
 * Throws InitDataError on any failure. maxAgeSeconds guards against replay of stale payloads.
 */
export function validateInitData(
  initDataRaw: string,
  botToken: string,
  maxAgeSeconds: number
): ValidatedInitData {
  const params = new URLSearchParams(initDataRaw);

  const hash = params.get("hash");
  if (!hash) {
    throw new InitDataError("Missing hash");
  }
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const computedHash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  const computedHashBuf = Buffer.from(computedHash, "hex");
  const hashBuf = Buffer.from(hash, "hex");
  if (
    computedHashBuf.length !== hashBuf.length ||
    !timingSafeEqual(computedHashBuf, hashBuf)
  ) {
    throw new InitDataError("Invalid hash");
  }

  const authDateRaw = params.get("auth_date");
  if (!authDateRaw) {
    throw new InitDataError("Missing auth_date");
  }
  const authDate = Number(authDateRaw);
  if (!Number.isFinite(authDate)) {
    throw new InitDataError("Invalid auth_date");
  }
  const ageSeconds = Date.now() / 1000 - authDate;
  if (ageSeconds > maxAgeSeconds || ageSeconds < -60) {
    throw new InitDataError("initData is stale or has an invalid auth_date");
  }

  const userRaw = params.get("user");
  if (!userRaw) {
    throw new InitDataError("Missing user field");
  }
  let user: TelegramUserField;
  try {
    user = JSON.parse(userRaw) as TelegramUserField;
  } catch {
    throw new InitDataError("Malformed user field");
  }
  if (typeof user.id !== "number") {
    throw new InitDataError("Malformed user field");
  }

  return {
    telegramId: user.id,
    telegramUsername: optionalString(user.username),
    telegramFirstName: optionalString(user.first_name),
    telegramLastName: optionalString(user.last_name),
  };
}
