const TELEGRAM_MESSAGE_MAX = 4096;
const TELEGRAM_CAPTION_MAX = 1024;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Deliberately small Markdown subset for admin posts. Raw HTML is escaped;
 * non-nested **bold**, *italic*, and _italic_ are converted to Telegram HTML.
 */
export function adminMarkdownToTelegramHtml(markdown: string): string {
  return escapeHtml(markdown)
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>")
    .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, "$1<i>$2</i>");
}

export function validHttpUrl(value: string, httpsOnly = false): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    return httpsOnly
      ? url.protocol === "https:"
      : url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function validMessage(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= TELEGRAM_MESSAGE_MAX
  );
}

export function validOptionalCaption(value: unknown): value is string | undefined {
  return (
    value === undefined ||
    (typeof value === "string" && value.length <= TELEGRAM_CAPTION_MAX)
  );
}
