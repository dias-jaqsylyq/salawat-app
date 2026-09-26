import { Flame } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  habitName: string;
  streak: number;
  /**
   * What `streak` counts. A weekly habit's run is measured in weeks, and the
   * badge has to say which — a bare 3 beside a daily habit's 3 would otherwise
   * read as three days and badly undersell three weeks.
   */
  unit?: "days" | "weeks";
}

type Tier = "unlit" | "lit" | "hot";

/**
 * Seven days is a week of daily practice; four weeks is roughly a month of
 * weekly practice. Different numbers, same "this has become a habit" moment —
 * so the hot tier is reached at a comparable point rather than the same digit.
 */
function streakTier(streak: number, unit: "days" | "weeks"): Tier {
  if (streak <= 0) return "unlit";
  if (streak >= (unit === "weeks" ? 4 : 7)) return "hot";
  return "lit";
}

export default function StreakBadge({ habitName, streak, unit = "days" }: Props) {
  const tier = streakTier(streak, unit);

  return (
    <div
      className={cn(
        "flex flex-col items-center gap-1 rounded-2xl border px-3 py-4 text-center transition-colors",
        tier === "unlit" && "border-border bg-surface-2",
        tier === "lit" && "border-accent/30 bg-accent/10",
        tier === "hot" && "border-accent/50 bg-accent/15 shadow-sm"
      )}
    >
      <Flame
        className={cn(
          "h-7 w-7",
          tier === "unlit" ? "text-quaternary" : "text-accent",
          tier === "hot" && "drop-shadow-[0_0_6px_color-mix(in_oklab,var(--accent)_40%,transparent)]"
        )}
        fill={tier === "unlit" ? "none" : "currentColor"}
        strokeWidth={tier === "unlit" ? 1.5 : 2}
        aria-hidden="true"
      />
      <span className="text-title numeric font-bold text-foreground">{streak}</span>
      <span className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">
        {streak === 1 ? unit.slice(0, -1) : unit}
      </span>
      <span className="mt-1 line-clamp-2 text-footnote font-semibold text-foreground">{habitName}</span>
    </div>
  );
}
