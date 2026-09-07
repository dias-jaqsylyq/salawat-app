export const REAL_NAME_MAX_LENGTH = 100;

export function validateRealName(realName: string): string | null {
  const trimmed = realName.trim();
  if (trimmed.length === 0 || trimmed.length > REAL_NAME_MAX_LENGTH) {
    return "Full name must be 1–100 characters.";
  }
  return null;
}

export function nicknameMatchesRealName(nickname: string, realName: string): boolean {
  return nickname.trim().toLowerCase() === realName.trim().toLowerCase();
}

export const NICKNAME_MATCHES_REAL_NAME_MESSAGE =
  "Your nickname must be different from your real name";
