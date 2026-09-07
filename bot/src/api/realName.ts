export const REAL_NAME_MAX_LENGTH = 100;

/** Trim and accept a 1–100 character real name, or null if invalid. */
export function parseRealName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > REAL_NAME_MAX_LENGTH) {
    return null;
  }
  return trimmed;
}

export function nicknameMatchesRealName(nickname: string, realName: string): boolean {
  return nickname.trim().toLowerCase() === realName.trim().toLowerCase();
}

export function userNeedsRealName(realName: string | null | undefined): boolean {
  return !realName;
}
