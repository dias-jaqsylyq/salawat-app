import { useEffect, useState } from "react";
import { Flame } from "lucide-react";
import { m, useReducedMotion } from "framer-motion";
import { Icon } from "@/components/ui/icon";
import { RollingNumber } from "./motion/AnimatedNumber.tsx";
import { hapticNotification } from "../lib/haptics.ts";
import { observeTier, streakTier } from "../lib/streakTier.ts";
import { cn } from "@/lib/utils";

interface Props {
  /** Stable per streak (room and personal ids overlap), for remembering what was last shown. */
  streakKey: string;
  habitName: string;
  streak: number;
  /**
   * What `streak` counts. A weekly habit's run is measured in weeks, and the
   * badge has to say which — a bare 3 beside a daily habit's 3 would otherwise
   * read as three days and badly undersell three weeks.
   */
  unit?: "days" | "weeks";
}

/**
 * Whether this badge should play its ignition now: once, when a streak the
 * viewer has already seen this session crosses into hot. Checked in an effect
 * so a StrictMode double render can't spend the one-shot sighting.
 */
function useIgnition(
  streakKey: string,
  tier: ReturnType<typeof streakTier>
): [boolean, (on: boolean) => void] {
  const reduce = useReducedMotion();
  const [igniting, setIgniting] = useState(false);
  useEffect(() => {
    if (!observeTier(streakKey, tier)) return;
    hapticNotification("success");
    if (!reduce) setIgniting(true);
  }, [streakKey, tier, reduce]);
  return [igniting, setIgniting];
}

export default function StreakBadge({ streakKey, habitName, streak, unit = "days" }: Props) {
  const tier = streakTier(streak, unit);
  const [igniting, setIgniting] = useIgnition(streakKey, tier);

  return (
    <div
      className={cn(
        "relative flex flex-col items-center gap-1 rounded-2xl border px-3 py-4 text-center transition-colors duration-300",
        tier === "unlit" && "border-border bg-surface-2",
        tier === "lit" && "border-accent/30 bg-accent/10",
        tier === "hot" && "border-accent/50 bg-accent/15 shadow-sm"
      )}
    >
      {igniting && (
        // A warm flash washing over the badge as it catches.
        <m.span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-2xl bg-accent/25"
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: [0, 1, 0], scale: [0.9, 1.04, 1.08] }}
          transition={{ duration: 0.7, ease: "easeOut" }}
          onAnimationComplete={() => setIgniting(false)}
        />
      )}
      <m.span
        className="relative inline-flex"
        animate={igniting ? { scale: [1, 0.7, 1.3, 1], rotate: [0, -10, 8, 0] } : undefined}
        transition={{ duration: 0.6, ease: "easeOut", times: [0, 0.2, 0.6, 1] }}
      >
        <Icon
          icon={Flame}
          size="lg"
          filled={tier !== "unlit"}
          className={cn(
            "transition-colors duration-300",
            tier === "unlit" ? "text-quaternary" : "text-accent",
            tier === "hot" && "drop-shadow-[0_0_6px_color-mix(in_oklab,var(--accent)_40%,transparent)]"
          )}
        />
      </m.span>
      <RollingNumber id={streakKey} value={streak} className="relative text-title numeric font-bold text-foreground" />
      <span className="relative text-caption font-semibold uppercase tracking-wide text-muted-foreground">
        {streak === 1 ? unit.slice(0, -1) : unit}
      </span>
      <span className="relative mt-1 line-clamp-2 text-footnote font-semibold text-foreground">{habitName}</span>
    </div>
  );
}
