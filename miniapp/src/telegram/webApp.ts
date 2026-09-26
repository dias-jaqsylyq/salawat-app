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

/** https://core.telegram.org/bots/webapps#popupbutton */
export interface TelegramPopupButton {
  id?: string;
  type?: "default" | "ok" | "close" | "cancel" | "destructive";
  text?: string;
}

/** https://core.telegram.org/bots/webapps#popupparams */
export interface TelegramPopupParams {
  title?: string;
  message: string;
  buttons?: TelegramPopupButton[];
}

interface TelegramWebApp {
  initData: string;
  version: string;
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
  /** Guards every call below: older clients either lack them or throw on unsupported input. */
  isVersionAtLeast(version: string): boolean;
  /** Bot API 6.2+. The callback gets the pressed button's id, or "" if dismissed. */
  showPopup(params: TelegramPopupParams, callback?: (buttonId: string) => void): void;
  onEvent(event: "themeChanged", handler: () => void): void;
  offEvent(event: "themeChanged", handler: () => void): void;
  /** Bot API 6.1+; hex colors in the header need 6.9+. */
  setHeaderColor(color: string): void;
  setBackgroundColor(color: string): void;
  /** Bot API 7.10+. */
  setBottomBarColor(color: string): void;
}

declare global {
  interface Window {
    Telegram?: {
      WebApp: TelegramWebApp;
    };
  }
}
