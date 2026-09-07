/** Medium tap feedback (e.g. Log counter). */
export function hapticMedium() {
  if (window.Telegram?.WebApp?.HapticFeedback) {
    window.Telegram.WebApp.HapticFeedback.impactOccurred("medium");
  } else if (navigator.vibrate) {
    navigator.vibrate(50);
  }
}

/** Stronger success pulse for milestone confetti. */
export function hapticSuccess() {
  const haptic = window.Telegram?.WebApp?.HapticFeedback;
  if (haptic) {
    try {
      haptic.notificationOccurred("success");
      return;
    } catch {
      try {
        haptic.impactOccurred("heavy");
        return;
      } catch {
        // fall through
      }
    }
  }
  if (navigator.vibrate) {
    navigator.vibrate([40, 30, 60]);
  }
}
