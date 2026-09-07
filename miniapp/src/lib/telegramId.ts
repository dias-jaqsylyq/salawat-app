/** Resolve the viewer's Telegram user id from WebApp user or raw initData. */
export function resolveTelegramId(initData: string, unsafeUserId?: number | null): number | null {
  if (typeof unsafeUserId === "number" && Number.isFinite(unsafeUserId) && unsafeUserId > 0) {
    return unsafeUserId;
  }
  try {
    const raw = new URLSearchParams(initData).get("user");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { id?: unknown };
    return typeof parsed.id === "number" ? parsed.id : null;
  } catch {
    return null;
  }
}
