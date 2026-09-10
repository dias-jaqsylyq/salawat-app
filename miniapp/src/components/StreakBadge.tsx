import { Flame } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  habitName: string;
  streak: number;
}

type Tier = "unlit" | "lit" | "hot";

function streakTier(streak: number): Tier {
  if (streak <= 0) return "unlit";
  if (streak >= 7) return "hot";
  return "lit";
}

export default function StreakBadge({ habitName, streak }: Props) {
  const tier = streakTier(streak);

  return (
    <div
      className={cn(
        "flex flex-col items-center gap-1 rounded-2xl border px-3 py-4 text-center transition-colors",
        tier === "unlit" && "border-border bg-muted/40",
        tier === "lit" && "border-accent/30 bg-accent/10",
        tier === "hot" && "border-accent/50 bg-accent/15 shadow-sm"
      )}
    >
      <Flame
        className={cn(
          "h-7 w-7",
          tier === "unlit" ? "text-muted-foreground/50" : "text-accent",
          tier === "hot" && "drop-shadow-[0_0_6px_rgba(161,98,7,0.35)] dark:drop-shadow-[0_0_6px_rgba(217,164,65,0.4)]"
        )}
        fill={tier === "unlit" ? "none" : "currentColor"}
        strokeWidth={tier === "unlit" ? 1.5 : 2}
        aria-hidden="true"
      />
      <span className="text-2xl font-extrabold tabular-nums text-foreground">{streak}</span>
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {streak === 1 ? "day" : "days"}
      </span>
      <span className="mt-1 line-clamp-2 text-xs font-medium text-foreground/80">{habitName}</span>
    </div>
  );
}
