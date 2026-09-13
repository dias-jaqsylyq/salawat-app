import { Flame } from "lucide-react";
import type { WeekDay, WeeklyHabitSummary, WeeklyProgressResponse } from "../api/types.ts";
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

/** "8–14 Sep" for the week's range, parsed as UTC so it cannot shift a day. */
function weekRange(from: string, to: string): string {
  const parse = (date: string) => {
    const [year, month, day] = date.split("-").map(Number);
    return new Date(Date.UTC(year!, month! - 1, day!));
  };
  const start = parse(from);
  const end = parse(to);
  const opts = { timeZone: "UTC", day: "numeric", month: "short" } as const;
  const sameMonth = start.getUTCMonth() === end.getUTCMonth();
  const startLabel = start.toLocaleDateString("en-GB", sameMonth ? { timeZone: "UTC", day: "numeric" } : opts);
  return `${startLabel}–${end.toLocaleDateString("en-GB", opts)}`;
}

/**
 * A weekly habit in the weekly view. Deliberately **not** a row of seven cells
 * like the daily habits above it: a week is one unit for these, so six unlit
 * days would read as six misses when in truth the member has nothing to miss
 * until Sunday. One badge for the whole week instead.
 *
 * The number is how many days of the week it is marked on — usually 0 or 1, but
 * genuinely more when the member ticked it on several days. Only the first of
 * those was worth points; the rest are still real marks, and the badge counts
 * what happened rather than what scored.
 */
function WeeklyHabitBadge({ habit, range }: { habit: WeeklyHabitSummary; range: string }) {
  const label = `${habit.name}, week of ${range}: ${
    habit.met ? `marked on ${habit.count} day${habit.count === 1 ? "" : "s"}` : "not yet marked"
  }`;

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-xl border px-3 py-2.5",
        habit.met ? "border-accent/40 bg-accent/10" : "border-dashed border-border/70 bg-muted/30"
      )}
      aria-label={label}
      title={label}
    >
      <div
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
          habit.met ? "bg-accent/20" : "bg-muted/50"
        )}
      >
        {habit.met ? (
          <span className="text-sm font-bold tabular-nums text-accent">{habit.count}</span>
        ) : (
          <Flame className="h-4 w-4 text-muted-foreground/50" strokeWidth={1.5} aria-hidden="true" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-foreground/80">{habit.name}</p>
        <p className="text-[11px] text-muted-foreground">
          {habit.met
            ? `${habit.count}× this week`
            : "Not yet this week"}
          {habit.streakWeeks > 0 &&
            ` · ${habit.streakWeeks} ${habit.streakWeeks === 1 ? "week" : "weeks"} in a row`}
        </p>
      </div>
    </div>
  );
}

/**
 * The weekly streak view.
 *
 * Daily habits get one row each, flat — never grouped by category, even in a
 * room that groups the Log screen that way, and never split between the room's
 * habits and the viewer's own private ones. Each row is the seven days of the
 * room's calendar week (Monday-Sunday), each cell a lit or unlit flame with no
 * "X of 7" counter anywhere.
 *
 * Weekly habits follow underneath in a section of their own, one badge each —
 * see WeeklyHabitBadge for why they cannot share the grid.
 */
export default function WeeklyStreakGrid({ week }: Props) {
  if (week.habits.length === 0 && week.weeklyHabits.length === 0) {
    return <p className="text-sm text-muted-foreground">No habits yet.</p>;
  }

  const range = weekRange(week.weekStart, week.weekEnd);

  return (
    <div className="space-y-3">
      {week.habits.length > 0 && (
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
      )}

      {week.habits.map((habit) => (
        // Room and personal habits come from different tables, so their ids can
        // collide — the kind has to be part of the key even though the two rows
        // are drawn identically.
        <div key={`${habit.personal ? "p" : "r"}-${habit.habitId}`} className="space-y-1.5">
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

      {week.weeklyHabits.length > 0 && (
        <div className="space-y-2 pt-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Once a week · {range}
          </p>
          {week.weeklyHabits.map((habit) => (
            <WeeklyHabitBadge key={`w-${habit.habitId}`} habit={habit} range={range} />
          ))}
        </div>
      )}
    </div>
  );
}
