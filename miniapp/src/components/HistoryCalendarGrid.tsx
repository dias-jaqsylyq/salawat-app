import { Flame } from "lucide-react";
import type { HistoryDay } from "../api/types.ts";
import { cn } from "@/lib/utils";

interface Props {
  days: HistoryDay[];
  /** The caller's own today — highlighted independent of its logged status. */
  today: string;
}

/** Monday-start, matching every other week grid in the app (WEEK_START_DAY). */
const WEEKDAY_INITIALS = ["M", "T", "W", "T", "F", "S", "S"] as const;

function dayOfMonth(date: string): string {
  return String(Number(date.slice(-2)));
}

/** "9 Sep 2024" — the tooltip/screen-reader date, since the cells carry no text of their own. */
function shortDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!)).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function cellLabel(day: HistoryDay, isToday: boolean): string {
  const when = `${shortDate(day.date)}${isToday ? " (today)" : ""}`;
  if (day.outOfMonth) return when;
  if (day.locked) return `${when}: before you could track this`;
  if (day.future) return `${when}: still to come`;
  return `${when}: ${day.logged ? "done" : "not done"}`;
}

/**
 * One day of the History month grid. Read-only by construction — a plain
 * element, never a button: logging still happens on the Log screen, not here.
 *
 * Colors deliberately avoid an alarming palette for a missed day: "not done"
 * is a neutral cell, not a warning one — this screen is for motivation, not
 * for calling out gaps.
 */
function DayCell({ day, isToday }: { day: HistoryDay; isToday: boolean }) {
  const inactive = day.locked || day.future || day.outOfMonth;

  return (
    <div
      role="img"
      aria-label={cellLabel(day, isToday)}
      title={cellLabel(day, isToday)}
      className={cn(
        "flex aspect-square items-center justify-center rounded-lg border text-caption font-semibold numeric transition-colors",
        day.logged && !day.outOfMonth && "border-accent/40 bg-accent/15 text-accent",
        !day.logged && inactive && "border-dashed border-border/50 bg-muted/20 text-muted-foreground/30",
        !day.logged && !inactive && "border-border bg-muted/40 text-foreground/70",
        // Today is marked independent of its own status — even locked, future
        // or unlogged, it still gets the ring.
        isToday && "ring-2 ring-primary ring-offset-1 ring-offset-background"
      )}
    >
      {day.logged && !day.outOfMonth ? (
        <Flame className="h-4 w-4" fill="currentColor" strokeWidth={2} aria-hidden="true" />
      ) : (
        dayOfMonth(day.date)
      )}
    </div>
  );
}

/**
 * A real calendar-month grid, weekday-aligned: `days` already includes the
 * leading/trailing days of adjacent months the server pads the grid with
 * (`outOfMonth`), so every row here is a full Monday-Sunday week.
 */
export default function HistoryCalendarGrid({ days, today }: Props) {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-7 gap-2" aria-hidden="true">
        {WEEKDAY_INITIALS.map((label, i) => (
          <span
            key={i}
            className="text-center text-caption font-semibold uppercase tracking-wide text-muted-foreground"
          >
            {label}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-2">
        {days.map((day) => (
          <DayCell key={day.date} day={day} isToday={day.date === today} />
        ))}
      </div>
    </div>
  );
}
