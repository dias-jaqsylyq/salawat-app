import { useEffect, useSyncExternalStore } from "react";
import { CircleAlert, CircleCheck, TriangleAlert, type LucideIcon } from "lucide-react";

import { Icon } from "@/components/ui/icon";
import { hapticNotification } from "@/lib/haptics";
import { cn } from "@/lib/utils";

export type ToastTone = "neutral" | "success" | "warning" | "error";

export interface ToastOptions {
  tone?: ToastTone;
  action?: { label: string; onClick: () => void };
  /** ms on screen; defaults to 3s, or 5s when there's an action to reach. */
  duration?: number;
}

interface ToastItem extends ToastOptions {
  id: number;
  message: string;
}

const TONES: Record<Exclude<ToastTone, "neutral">, { icon: LucideIcon; className: string }> = {
  success: { icon: CircleCheck, className: "text-primary" },
  warning: { icon: TriangleAlert, className: "text-warning" },
  error: { icon: CircleAlert, className: "text-destructive" },
};

// A tiny module-level queue: toast() works from anywhere, <Toaster /> renders the head.
let queue: readonly ToastItem[] = [];
let nextId = 0;
const listeners = new Set<() => void>();

function setQueue(next: readonly ToastItem[]) {
  queue = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function dismiss(id: number) {
  setQueue(queue.filter((item) => item.id !== id));
}

/** Shows a short, non-blocking message above the tab bar. One at a time; the rest wait. */
export function toast(message: string, options: ToastOptions = {}) {
  setQueue([...queue, { id: ++nextId, message, ...options }]);
}

/** Mount once near the app root. */
export function Toaster() {
  const items = useSyncExternalStore(subscribe, () => queue);
  const current = items[0];

  useEffect(() => {
    if (!current) return;
    if (current.tone && current.tone !== "neutral") hapticNotification(current.tone);
    const timer = setTimeout(() => dismiss(current.id), current.duration ?? (current.action ? 5000 : 3000));
    return () => clearTimeout(timer);
  }, [current]);

  const tone = current?.tone && current.tone !== "neutral" ? TONES[current.tone] : null;

  return (
    // Clears the tab bar (~56px) and the home-indicator inset.
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+4rem)] z-50 flex justify-center px-4"
    >
      {current && (
        <div
          key={current.id}
          role={current.tone === "error" ? "alert" : "status"}
          className="pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-xl border bg-surface-1 px-4 py-3 shadow-lg duration-200 animate-in fade-in slide-in-from-bottom-2 motion-reduce:animate-none"
        >
          {tone && <Icon icon={tone.icon} size="md" className={tone.className} />}
          <p className="min-w-0 flex-1 text-body text-foreground">{current.message}</p>
          {current.action && (
            <button
              type="button"
              className={cn(
                "-my-2 -mr-2 min-h-11 shrink-0 rounded-lg px-2 text-body font-semibold text-primary",
                "transition duration-100 active:scale-[0.97] active:bg-fill-pressed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              )}
              onClick={() => {
                current.action?.onClick();
                dismiss(current.id);
              }}
            >
              {current.action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
