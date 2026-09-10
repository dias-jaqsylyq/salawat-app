export interface TelegramWebAppUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  photo_url?: string;
}

/** https://core.telegram.org/bots/webapps#hapticfeedback */
interface TelegramHapticFeedback {
  impactOccurred(style: "light" | "medium" | "heavy" | "rigid" | "soft"): void;
  notificationOccurred(type: "error" | "success" | "warning"): void;
  selectionChanged(): void;
}

interface TelegramWebApp {
  initData: string;
  initDataUnsafe: {
    user?: TelegramWebAppUser;
    [key: string]: unknown;
  };
  colorScheme: "light" | "dark";
  HapticFeedback: TelegramHapticFeedback;
  ready(): void;
  expand(): void;
  /**
   * Opens a t.me link inside Telegram itself (rather than a browser tab) —
   * what makes the room invite share sheet work from the Mini App.
   * Optional: older Telegram clients don't implement it.
   */
  openTelegramLink?(url: string): void;
}

declare global {
  interface Window {
    Telegram?: {
      WebApp: TelegramWebApp;
    };
  }
}
