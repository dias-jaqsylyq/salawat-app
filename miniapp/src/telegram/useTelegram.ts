import { useEffect, useState } from "react";
import type { TelegramWebAppUser } from "./webApp.ts";

export interface TelegramContext {
  /** Raw initData string, sent as-is in the Authorization header. */
  initData: string;
  user: TelegramWebAppUser | null;
  /** False when not running inside Telegram and not in dev mode — show a fallback screen. */
  available: boolean;
}

function resolveTelegramContext(): TelegramContext {
  const webApp = window.Telegram?.WebApp;
  if (webApp?.initData) {
    return { initData: webApp.initData, user: webApp.initDataUnsafe.user ?? null, available: true };
  }

  if (import.meta.env.DEV) {
    // A real initData captured from an actual Telegram session, for full local
    // API testing (see VITE_DEV_INIT_DATA in .env.example).
    const devInitData = import.meta.env.VITE_DEV_INIT_DATA;
    if (devInitData) {
      return { initData: devInitData, user: null, available: true };
    }
    // No captured initData either: still let the UI render so layout/flow can be
    // checked in a normal browser, but every API call will get a 401 since this
    // isn't signed by the real bot token.
    return {
      initData: "",
      user: { id: 0, first_name: "Dev" },
      available: true,
    };
  }

  return { initData: "", user: null, available: false };
}

/** Bootstraps the Telegram WebApp bridge and exposes initData/user for the rest of the app. */
export function useTelegram(): TelegramContext {
  const [context] = useState(resolveTelegramContext);

  useEffect(() => {
    const webApp = window.Telegram?.WebApp;
    if (webApp) {
      webApp.ready();
      webApp.expand();
    }
  }, []);

  return context;
}
