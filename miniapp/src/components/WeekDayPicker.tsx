import { ChevronLeft, ChevronRight } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { backfillWeekView, dayForWeekStep } from "../lib/backfillWeeks.ts";
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

const ARROW_CLASS =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition duration-100 active:scale-[0.97] hover:text-foreground active:bg-fill-pressed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-30";

/**
 * The Log screen's day picker (BACKFILL PRD): one Monday-Sunday week at a
 * time under a "This week" / "Last week" / "2 weeks ago" header, with ◄/► to
 * step between weeks. The header alone says which week is being edited — no
 * separate banner. Stepping to another week lands on its Sunday (today, for
 * the current week). ► is hidden on the current week — there is no future to
 * step into — and ◄ is disabled once the previous week would fall entirely
 * outside the window (2 weeks back, or the member's room join).
 *
 * Days outside [minDate, today] stay in the row, inert, so the week always
 * reads as a whole Monday-Sunday.
 *
 * Renders nothing when there is only one day to show across the whole window
 * (a brand-new member on the day they joined, say): a single-day picker has
 * nothing to switch between.
 */
export default function WeekDayPicker({ minDate, today, selected, onSelect }: Props) {
  if (minDate >= today) return null;

  const view = backfillWeekView(minDate, today, selected);

  function step(weeks: number) {
    const day = dayForWeekStep(minDate, today, selected, weeks);
    if (day !== null) onSelect(day);
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label="Previous week"
          disabled={!view.canGoBack}
          onClick={() => step(-1)}
          className={ARROW_CLASS}
        >
          <Icon icon={ChevronLeft} />
        </button>
        <p className="flex-1 text-center text-footnote font-semibold text-muted-foreground" aria-live="polite">
          {view.label}
        </p>
        <button
          type="button"
          aria-label="Next week"
          disabled={!view.canGoForward}
          onClick={() => step(1)}
          className={cn(ARROW_CLASS, !view.canGoForward && "invisible")}
        >
          <Icon icon={ChevronRight} />
        </button>
      </div>
      <div
        role="tablist"
        aria-label={view.label}
        className="flex gap-1 rounded-xl bg-surface-2 p-1"
      >
        {view.days.map(({ date, selectable }) => {
          const isSelected = date === selected;
          return (
            <button
              key={date}
              type="button"
              role="tab"
              aria-selected={isSelected}
              disabled={!selectable}
              onClick={() => onSelect(date)}
              className={cn(
                "flex flex-1 flex-col items-center gap-1 rounded-lg py-2 text-footnote font-semibold transition duration-100 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40",
                isSelected
                  ? "bg-surface-1 text-foreground shadow-sm dark:bg-surface-3"
                  : "text-muted-foreground hover:text-foreground active:bg-fill-pressed"
              )}
            >
              <span>{weekdayLabel(date)}</span>
              <span className="numeric text-caption">{dayOfMonth(date)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
