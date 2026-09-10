/** Medium tap feedback (e.g. logging a habit). */
export function hapticMedium() {
  if (window.Telegram?.WebApp?.HapticFeedback) {
    window.Telegram.WebApp.HapticFeedback.impactOccurred("medium");
  } else if (navigator.vibrate) {
    navigator.vibrate(50);
  }
}
