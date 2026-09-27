/** Medium tap feedback (e.g. logging a habit). */
export function hapticMedium() {
  if (window.Telegram?.WebApp?.HapticFeedback) {
    window.Telegram.WebApp.HapticFeedback.impactOccurred("medium");
  } else if (navigator.vibrate) {
    navigator.vibrate(50);
  }
}

/** Light tick when a selection changes (segmented controls, pickers). */
export function hapticSelection() {
  window.Telegram?.WebApp?.HapticFeedback?.selectionChanged();
}

/** Outcome feedback, e.g. alongside a toast. */
export function hapticNotification(type: "error" | "success" | "warning") {
  window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred(type);
}
