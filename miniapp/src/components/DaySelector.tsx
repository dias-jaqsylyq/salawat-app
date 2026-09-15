import { cn } from "@/lib/utils";

interface Props {
  /** Inclusive lower bound of the backfill window — the picker's first tab. */
  minDate: string;
  /** The caller's own today — the picker's last tab, and its default selection. */
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

function datesFromTo(from: string, to: string): string[] {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const start = Date.UTC(fy!, fm! - 1, fd!);
  const end = Date.UTC(ty!, tm! - 1, td!);
  const dates: string[] = [];
  for (let t = start; t <= end; t += 86_400_000) {
    dates.push(new Date(t).toISOString().slice(0, 10));
  }
  return dates;
}

/**
 * The Log screen's own day picker (BACKFILL PRD): every day from the
 * backfill window's `minDate` through `today`, "today" selected by default.
 * Not the room's whole Monday-Sunday week — a day still to come has nothing
 * to log yet, so it is never offered as a tab, only ever the days that have
 * actually happened.
 *
 * Renders nothing when there is only one day to show (a brand-new member on
 * the Monday they joined, say): a single-tab picker has nothing to switch
 * between and would just be an inert button.
 */
export default function DaySelector({ minDate, today, selected, onSelect }: Props) {
  const days = datesFromTo(minDate, today);
  if (days.length <= 1) return null;

  return (
    <div
      role="tablist"
      aria-label="Day"
      className="flex gap-1 rounded-xl bg-secondary/60 p-1"
    >
      {days.map((date) => {
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
  );
}
