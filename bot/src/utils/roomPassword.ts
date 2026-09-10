import { randomInt } from "node:crypto";

/**
 * Room join passwords double as Telegram deep-link payloads
 * (`t.me/<bot>?start=<password>`, MULTI ROOM PRD §3a), and Telegram only
 * accepts `A-Za-z0-9_-`, up to 64 characters, in a start payload. So the same
 * charset bounds both a generated password and one an admin types themselves —
 * anything outside it would silently produce an unusable share link.
 */
const ALLOWED_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Minimum length for an admin-typed password (PRD §3a). */
export const MIN_ROOM_PASSWORD_LENGTH = 6;
/** Telegram's start-payload ceiling. */
export const MAX_ROOM_PASSWORD_LENGTH = 64;

/**
 * Unambiguous alphabet for generated passwords: no 0/O, 1/l/I — these get read
 * aloud and retyped by participants.
 */
const GENERATOR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const GENERATED_LENGTH = 8;

/**
 * Validity of an admin-chosen password. Passwords are case-sensitive
 * (`ABC` != `abc`), so nothing here normalizes case.
 */
export function isValidRoomPassword(value: string): boolean {
  return (
    value.length >= MIN_ROOM_PASSWORD_LENGTH &&
    value.length <= MAX_ROOM_PASSWORD_LENGTH &&
    ALLOWED_PATTERN.test(value)
  );
}

/**
 * A random room password. The caller retries on the (vanishingly unlikely)
 * `rooms.password` UNIQUE collision — the column is what guarantees a password
 * resolves to exactly one room, not this generator.
 */
export function generateRoomPassword(): string {
  let password = "";
  for (let i = 0; i < GENERATED_LENGTH; i++) {
    password += GENERATOR_ALPHABET[randomInt(GENERATOR_ALPHABET.length)];
  }
  return password;
}

/**
 * A room's Telegram deep link (MULTI ROOM PRD §3a): following it pre-fills the
 * password and drops a brand-new user straight into this room's signup. Room
 * passwords are restricted to Telegram's start-payload charset (above), so no
 * escaping is needed here.
 */
export function roomInviteLink(botUsername: string, password: string): string {
  return `https://t.me/${botUsername}?start=${password}`;
}
