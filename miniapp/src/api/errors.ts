import { ApiError } from "./client.ts";

/** Map API error codes to short user-facing copy. */
export function messageForApiError(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) {
    return "Network error — please try again.";
  }

  switch (err.code) {
    case "invalid_habit_id":
    case "habit_not_found":
      return "That habit isn't available anymore.";
    case "habit_inactive":
      return "This habit is no longer active.";
    case "invalid_value":
      return "Enter a valid whole number.";
    case "invalid_name":
      return "Name must be 1–100 characters.";
    case "invalid_type":
      return "Choose a valid habit type.";
    case "invalid_points_weight":
      return "Points must be a whole number between 1 and 1,000,000.";
    case "invalid_is_active":
      return "That active/inactive value is invalid.";
    case "invalid_nickname":
      return "Nickname must be 1–50 characters.";
    case "invalid_real_name":
      return "Full name must be 1–100 characters.";
    case "nickname_matches_real_name":
      return "Your nickname must be different from your real name";
    case "nickname_taken":
      return "That nickname is taken — try another.";
    case "invalid_reminder_enabled":
      return "Reminder setting is invalid.";
    case "invalid_reminder_time":
      return "Enter a valid reminder time (HH:mm).";
    case "invalid_body":
      return "Nothing to save — change something first.";
    case "rate_limited":
      return "You're doing that too fast — wait a moment and try again.";
    case "not_registered":
      return "Please finish /start in the bot chat first.";
    case "register_via_bot":
      return "Registration happens in the bot — send /start there.";
    case "not_admin":
      return "This account does not have admin access.";
    case "broadcast_in_progress":
      return "Another broadcast is still sending — wait for it to finish.";
    case "invalid_message":
      return "Enter a message before sending.";
    case "invalid_link":
      return "Enter a valid HTTP or HTTPS link.";
    case "invalid_file_url":
      return "Enter a valid HTTPS document link.";
    case "invalid_file":
    case "invalid_pdf":
      return "Choose a valid PDF file.";
    case "file_too_large":
      return "PDF must be 20 MB or smaller.";
    case "invalid_caption":
      return "The caption is too long.";
    case "missing_init_data":
    case "invalid_init_data":
      return "Telegram session expired — close and reopen the app from the bot menu.";
    default:
      return fallback;
  }
}
