import { Flame } from "lucide-react";
import type { WeekDay, WeeklyProgressResponse } from "../api/types.ts";
import { cn } from "@/lib/utils";

interface Props {
  week: WeeklyProgressResponse;
}

const WEEKDAY_INITIALS = ["S", "M", "T", "W", "T", "F", "S"] as const;
const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/**
 * Weekday of a YYYY-MM-DD key. Parsed as UTC on purpose: these are calendar
 * dates the server already resolved in the viewer's timezone, so re-reading
 * them in the browser's local zone could shift them by a day.
 */
function weekdayOf(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay();
}

/** "9 Sep" — the tooltip/screen-reader date, since the cells carry no text. */
function shortDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!)).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
  });
}

function cellLabel(day: WeekDay, habitName: string): string {
  const when = `${WEEKDAY_NAMES[weekdayOf(day.date)]} ${shortDate(day.date)}`;
  if (day.locked) return `${habitName}, ${when}: before you joined`;
  if (day.future) return `${habitName}, ${when}: still to come`;
  return `${habitName}, ${when}: ${day.logged ? "logged" : "not logged"}`;
}

/**
 * One cell. Deliberately a plain element and not a button: the weekly view is
 * for looking at, and logging still happens on the Log tab, for today only.
 */
function DayCell({
  day,
  habitName,
  isToday,
}: {
  day: WeekDay;
  habitName: string;
  isToday: boolean;
}) {
  // Neither lit nor missed: greyed out rather than scored against the member.
  const inactive = day.locked || day.future;

  return (
    <div
      role="img"
      aria-label={cellLabel(day, habitName)}
      title={cellLabel(day, habitName)}
      className={cn(
        "flex aspect-square items-center justify-center rounded-lg border transition-colors",
        day.logged && "border-accent/40 bg-accent/15",
        !day.logged && inactive && "border-dashed border-border/60 bg-muted/30",
        !day.logged && !inactive && "border-border bg-muted/40",
        // Today is marked, not made tappable.
        isToday && "ring-2 ring-primary ring-offset-1 ring-offset-background"
      )}
    >
      {day.logged ? (
        <Flame
          className="h-4 w-4 text-accent"
          fill="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        />
      ) : (
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            inactive ? "bg-muted-foreground/25" : "bg-muted-foreground/40"
          )}
          aria-hidden="true"
        />
      )}
    </div>
  );
}

/**
 * The weekly streak view: one row per **active** habit, flat — never grouped by
 * category, even in a room that groups the Log screen that way. Each row is the
 * seven days of the current calendar week (from the viewer's chosen start day),
 * each cell a lit or unlit flame with no "X of 7" counter anywhere.
 */
export default function WeeklyStreakGrid({ week }: Props) {
  if (week.habits.length === 0) {
    return <p className="text-sm text-muted-foreground">No habits yet.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-7 gap-1.5" aria-hidden="true">
        {week.days.map((date) => (
          <span
            key={date}
            className={cn(
              "text-center text-[11px] font-medium uppercase tracking-wide",
              date === week.today ? "text-foreground" : "text-muted-foreground"
            )}
          >
            {WEEKDAY_INITIALS[weekdayOf(date)]}
          </span>
        ))}
      </div>

      {week.habits.map((habit) => (
        <div key={habit.habitId} className="space-y-1.5">
          <p className="truncate text-xs font-medium text-foreground/80">{habit.name}</p>
          <div className="grid grid-cols-7 gap-1.5">
            {habit.days.map((day) => (
              <DayCell
                key={day.date}
                day={day}
                habitName={habit.name}
                isToday={day.date === week.today}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
