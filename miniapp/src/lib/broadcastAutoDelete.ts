/** Keep in step with the bot's BROADCAST_AUTO_DELETE_MAX_HOURS. */
export const BROADCAST_AUTO_DELETE_MAX_HOURS = 720;
export const BROADCAST_AUTO_DELETE_DEFAULT_HOURS = 24;

/**
 * The admin's auto-delete input as hours to send: null keeps the post forever,
 * an empty field is the 24-hour default, otherwise a whole number 1..720.
 * Returns an error message instead for anything else.
 */
export function resolveAutoDeleteHours(
  keepForever: boolean,
  input: string
): { hours: number | null } | { error: string } {
  if (keepForever) return { hours: null };
  const trimmed = input.trim();
  if (!trimmed) return { hours: BROADCAST_AUTO_DELETE_DEFAULT_HOURS };
  if (!/^\d+$/.test(trimmed)) return { error: "Auto-delete must be a whole number of hours." };
  const hours = Number(trimmed);
  if (hours < 1 || hours > BROADCAST_AUTO_DELETE_MAX_HOURS) {
    return {
      error: `Auto-delete must be between 1 and ${BROADCAST_AUTO_DELETE_MAX_HOURS} hours.`,
    };
  }
  return { hours };
}

/** The line the send confirmation shows about what happens to the post. */
export function autoDeleteConfirmLine(hours: number | null): string {
  if (hours === null) return "This post will stay forever.";
  return `This post will be deleted in ${hours} hour${hours === 1 ? "" : "s"}.`;
}
