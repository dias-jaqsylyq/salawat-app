/** Telegram caps popup titles at 64 characters and messages at 256. */
const MAX_TITLE = 64;
const MAX_MESSAGE = 256;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export interface ConfirmOptions {
  title: string;
  message: string;
  /** Label of the confirming button, e.g. "Delete". */
  okText: string;
  /** Renders the confirming button in Telegram's red destructive style. */
  destructive?: boolean;
}

/**
 * Asks the user to confirm an action with Telegram's native popup, falling back
 * to window.confirm outside Telegram (or on clients older than Bot API 6.2).
 * Resolves true only if the confirming button was pressed.
 */
export function confirmAction({ title, message, okText, destructive = false }: ConfirmOptions): Promise<boolean> {
  const webApp = window.Telegram?.WebApp;
  if (!webApp?.initData || !webApp.isVersionAtLeast?.("6.2")) {
    return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  }

  return new Promise((resolve) => {
    try {
      webApp.showPopup(
        {
          title: clip(title, MAX_TITLE),
          message: clip(message, MAX_MESSAGE),
          buttons: [
            { id: "ok", type: destructive ? "destructive" : "default", text: okText },
            { type: "cancel" },
          ],
        },
        (buttonId) => resolve(buttonId === "ok")
      );
    } catch {
      // Thrown when another popup is already open — treat as not confirmed.
      resolve(false);
    }
  });
}
