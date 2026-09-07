import { useEffect, useRef, useState } from "react";
import confetti from "canvas-confetti";
import { MoonStar } from "lucide-react";
import type { CelebrationEvent } from "../lib/milestones.ts";
import { hapticSuccess } from "../lib/haptics.ts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const CONFETTI_COLORS = ["#047857", "#10b981", "#a16207", "#d9a441", "#f5e6b8"];

interface Props {
  celebration: CelebrationEvent;
  onContinue: () => void;
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

function fireConfetti() {
  const defaults = {
    colors: CONFETTI_COLORS,
    disableForReducedMotion: true,
  };
  void confetti({
    ...defaults,
    particleCount: 80,
    spread: 70,
    origin: { x: 0.5, y: 0.45 },
  });
  window.setTimeout(() => {
    void confetti({
      ...defaults,
      particleCount: 40,
      angle: 60,
      spread: 55,
      origin: { x: 0.2, y: 0.55 },
    });
    void confetti({
      ...defaults,
      particleCount: 40,
      angle: 120,
      spread: 55,
      origin: { x: 0.8, y: 0.55 },
    });
  }, 120);
}

export default function CelebrationOverlay({ celebration, onContinue }: Props) {
  const [phase, setPhase] = useState(0);
  const [displayValue, setDisplayValue] = useState(celebration.from);
  const [showSubtitle, setShowSubtitle] = useState(false);
  const [showButton, setShowButton] = useState(false);
  const celebratedKey = useRef(celebration.id);
  const reducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  // Reset sequence when a new celebration becomes active.
  useEffect(() => {
    celebratedKey.current = celebration.id;
    setPhase(0);
    setDisplayValue(celebration.from);
    setShowSubtitle(false);
    setShowButton(false);

    const timers: number[] = [];
    timers.push(window.setTimeout(() => setPhase(1), 0));
    timers.push(window.setTimeout(() => setPhase(2), 100));
    timers.push(window.setTimeout(() => setPhase(3), 400));
    timers.push(window.setTimeout(() => setPhase(4), 700));

    return () => {
      for (const id of timers) window.clearTimeout(id);
    };
  }, [celebration.id, celebration.from]);

  // Count-up + confetti/haptic at end.
  useEffect(() => {
    if (phase < 4) return;

    const from = celebration.from;
    const to = celebration.to;
    const duration = reducedMotion ? 0 : Math.min(1200, Math.max(800, Math.abs(to - from) * 2));

    if (duration === 0) {
      setDisplayValue(to);
      fireConfetti();
      hapticSuccess();
      window.setTimeout(() => setShowSubtitle(true), 200);
      window.setTimeout(() => setShowButton(true), 500);
      return;
    }

    let frame = 0;
    const start = performance.now();

    const tick = (now: number) => {
      if (celebratedKey.current !== celebration.id) return;
      const t = Math.min(1, (now - start) / duration);
      const value = Math.round(from + (to - from) * easeOutCubic(t));
      setDisplayValue(value);
      if (t < 1) {
        frame = requestAnimationFrame(tick);
      } else {
        setDisplayValue(to);
        fireConfetti();
        hapticSuccess();
        window.setTimeout(() => {
          if (celebratedKey.current === celebration.id) setShowSubtitle(true);
        }, 200);
        window.setTimeout(() => {
          if (celebratedKey.current === celebration.id) setShowButton(true);
        }, 500);
      }
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [phase, celebration.from, celebration.to, celebration.id, reducedMotion]);

  const numberLabel =
    celebration.kind === "streak"
      ? `${displayValue.toLocaleString()}`
      : displayValue.toLocaleString();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="celebration-title"
    >
      <div
        className={cn(
          "absolute inset-0 bg-black/50 transition-opacity duration-300",
          phase >= 1 ? "opacity-100" : "opacity-0"
        )}
      />

      <div className="relative z-10 flex w-full max-w-sm flex-col items-center text-center">
        <div
          className={cn(
            "mb-5 flex h-20 w-20 items-center justify-center rounded-full bg-accent/15 text-[#854d0e] transition-transform duration-500 ease-out dark:bg-accent/20 dark:text-[#e6bf6a]",
            phase >= 2 ? "scale-100" : "scale-0",
            phase >= 2 && "animate-[celebration-bounce_500ms_ease-out]"
          )}
        >
          <MoonStar className="h-10 w-10" aria-hidden="true" />
        </div>

        <h2
          id="celebration-title"
          className={cn(
            "text-3xl font-bold tracking-tight text-foreground transition-all duration-300",
            phase >= 3 ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0"
          )}
        >
          MashaAllah!
        </h2>

        <p
          className={cn(
            "mt-4 text-5xl font-bold tabular-nums tracking-tight text-foreground transition-opacity duration-300",
            phase >= 4 ? "opacity-100" : "opacity-0"
          )}
        >
          {numberLabel}
          {celebration.kind === "streak" ? (
            <span className="ml-2 text-2xl font-semibold text-muted-foreground">days</span>
          ) : null}
        </p>

        <p
          className={cn(
            "mt-3 text-base text-muted-foreground transition-opacity duration-300",
            showSubtitle ? "opacity-100" : "opacity-0"
          )}
        >
          {celebration.subtitle}
        </p>

        <div
          className={cn(
            "mt-8 w-full transition-opacity duration-300",
            showButton ? "opacity-100" : "pointer-events-none opacity-0"
          )}
        >
          <Button type="button" size="lg" className="w-full" onClick={onContinue} disabled={!showButton}>
            Continue
          </Button>
        </div>
      </div>

      <style>{`
        @keyframes celebration-bounce {
          0% { transform: scale(0); }
          60% { transform: scale(1.15); }
          100% { transform: scale(1); }
        }
      `}</style>
    </div>
  );
}
