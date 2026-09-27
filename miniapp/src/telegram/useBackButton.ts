import { useEffect, useRef } from "react";

/**
 * Shows Telegram's native header back button while `active`, calling `onBack`
 * when it's pressed. No-op outside Telegram or on clients before Bot API 6.1.
 */
export function useTelegramBackButton(active: boolean, onBack: () => void) {
  const onBackRef = useRef(onBack);
  useEffect(() => {
    onBackRef.current = onBack;
  });

  useEffect(() => {
    const webApp = window.Telegram?.WebApp;
    if (!active || !webApp?.initData || !webApp.isVersionAtLeast("6.1")) return;
    const handle = () => onBackRef.current();
    webApp.BackButton.onClick(handle);
    webApp.BackButton.show();
    return () => {
      webApp.BackButton.offClick(handle);
      webApp.BackButton.hide();
    };
  }, [active]);
}
