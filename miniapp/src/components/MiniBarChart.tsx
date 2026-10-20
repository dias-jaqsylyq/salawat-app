import { chartBars, chartSummary, shortDate } from "@/lib/statsChart";
import { cn } from "@/lib/utils";

interface Props {
  /** Completions per week, oldest first; null = before the habit existed. */
  weekly: (number | null)[];
  /** Mondays of the same weeks, for the axis and the screen-reader summary. */
  weekStarts: string[];
  currentWeekIndex: number;
  bestWeekIndex: number | null;
  /** A paused habit draws in the muted color. */
  muted?: boolean;
}

/** Slot width in viewBox units; a bar is BAR wide and centred in its slot. */
const SLOT = 10;
const BAR = 6;
const HEIGHT = 48;

/**
 * The last few weeks of one habit as small bars, an inline SVG rather than a
 * charting dependency. Every week keeps its own slot, so the same week sits
 * in the same column on every card; a week before the habit existed is simply
 * left empty. The unfinished current week is drawn lighter and labelled "this
 * week", and the best closed week carries a small "best" label.
 */
export default function MiniBarChart({ weekly, weekStarts, currentWeekIndex, bestWeekIndex, muted = false }: Props) {
  const bars = chartBars(weekly, currentWeekIndex, bestWeekIndex);
  const slots = weekly.length;
  const firstIndex = bars[0]?.index ?? currentWeekIndex;

  return (
    <figure className="space-y-1" role="img" aria-label={chartSummary(bars, weekStarts)}>
      <div className="grid text-center" style={{ gridTemplateColumns: `repeat(${slots}, minmax(0, 1fr))` }}>
        {weekly.map((_, index) => (
          <span key={index} className="text-caption font-semibold text-accent" aria-hidden="true">
            {index === bestWeekIndex ? "best" : "\u00a0"}
          </span>
        ))}
      </div>

      <svg
        viewBox={`0 0 ${slots * SLOT} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="block h-12 w-full"
        aria-hidden="true"
      >
        {bars.map((bar) => {
          const x = bar.index * SLOT + (SLOT - BAR) / 2;
          if (bar.height === 0) {
            // A real week with nobody: a hairline on the baseline.
            return <rect key={bar.index} x={x} y={HEIGHT - 1} width={BAR} height={1} className="fill-border" />;
          }
          const height = bar.height * HEIGHT;
          return (
            <rect
              key={bar.index}
              x={x}
              y={HEIGHT - height}
              width={BAR}
              height={height}
              rx={1}
              className={cn(muted ? "fill-quaternary" : "fill-primary", bar.isCurrent && "opacity-40")}
            />
          );
        })}
      </svg>

      <div className="flex justify-between gap-2 text-caption text-muted-foreground" aria-hidden="true">
        <span>{firstIndex < currentWeekIndex ? shortDate(weekStarts[firstIndex] ?? "") : ""}</span>
        <span>this week</span>
      </div>
    </figure>
  );
}
