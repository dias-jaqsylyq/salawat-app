/**
 * Copy text to the clipboard, resolving to whether it worked.
 *
 * `navigator.clipboard` is unavailable in some Telegram WebViews (and in any
 * non-secure context), so this falls back to the legacy execCommand path rather
 * than leaving the admin with no way to share their room password.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path below.
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    // Off-screen but still focusable — execCommand only copies a live selection.
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-1000px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}
