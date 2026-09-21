import { groupBackfillDays } from "../lib/backfillWeeks.ts";
import { cn } from "@/lib/utils";

interface Props {
  /** Inclusive lower bound of the backfill window — up to 3 weeks back (BACKFILL PRD). */
  minDate: string;
  /** The caller's own today — the window's upper bound, and its default selection. */
  today: string;
  selected: string;
  onSelect: (date: string) => void;
}

/** "Mon", parsed as UTC so a local read of the YYYY-MM-DD string can never shift a day. */
function weekdayLabel(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  return parsed.toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "short" });
}

function dayOfMonth(date: string): string {
  return String(Number(date.slice(-2)));
}

/**
 * The Log screen's own day picker (BACKFILL PRD): every day from the
 * backfill window's `minDate` through `today`, grouped under one header per
 * week — "This week" / "Last week" / "2 weeks ago" — all three visible at
 * once as a vertical list, with no separate control to switch between them.
 * A week older than the window simply never appears, unlabeled.
 *
 * Renders nothing when there is only one day to show across the whole window
 * (a brand-new member on the day they joined, say): a single-tab picker has
 * nothing to switch between and would just be an inert button.
 */
export default function BackfillDayList({ minDate, today, selected, onSelect }: Props) {
  const groups = groupBackfillDays(minDate, today);
  const totalDays = groups.reduce((count, group) => count + group.dates.length, 0);
  if (totalDays <= 1) return null;

  return (
    <div className="space-y-3">
      {groups.map((group) => (
        <div key={group.label} className="space-y-1">
          <p className="px-1 text-xs font-medium text-muted-foreground">{group.label}</p>
          <div
            role="tablist"
            aria-label={group.label}
            className="flex gap-1 rounded-xl bg-secondary/60 p-1"
          >
            {group.dates.map((date) => {
              const isSelected = date === selected;
              return (
                <button
                  key={date}
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  onClick={() => onSelect(date)}
                  className={cn(
                    "flex flex-1 flex-col items-center gap-0.5 rounded-lg py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    isSelected
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <span>{weekdayLabel(date)}</span>
                  <span className="tabular-nums text-[11px]">{dayOfMonth(date)}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
