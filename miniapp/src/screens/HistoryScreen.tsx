import { useEffect, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Flame } from "lucide-react";
import { getHistoryHabits, getHistoryMonth } from "../api/client.ts";
import { messageForApiError } from "../api/errors.ts";
import type { HistoryHabitListEntry, HistoryMonthResponse, HistoryWeek } from "../api/types.ts";
import HistoryCalendarGrid from "../components/HistoryCalendarGrid.tsx";
import HistoryHabitPicker from "../components/HistoryHabitPicker.tsx";
import { loadLastHabit, loadLastMonth, saveLastHabit, saveLastMonth } from "../lib/historyPrefs.ts";
import { currentMonthKey, formatMonthLabel, shiftMonthKey } from "../lib/monthKey.ts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  initData: string;
  /** Decides the empty-state CTA's destination and its copy. */
  isAdmin: boolean;
  onBack: () => void;
  /** Leaves History and switches the bottom tab — the empty state's "go add a habit" button. */
  onNavigateAway: (tab: "log" | "admin") => void;
}

/** "8–14 Sep" for a week's range, parsed as UTC so it can never shift a day. */
function weekRangeLabel(from: string, to: string): string {
  const parse = (date: string) => {
    const [year, month, day] = date.split("-").map(Number);
    return new Date(Date.UTC(year!, month! - 1, day!));
  };
  const start = parse(from);
  const end = parse(to);
  const full = { timeZone: "UTC", day: "numeric", month: "short" } as const;
  const sameMonth = start.getUTCMonth() === end.getUTCMonth();
  const startLabel = start.toLocaleDateString("en-GB", sameMonth ? { timeZone: "UTC", day: "numeric" } : full);
  return `${startLabel}–${end.toLocaleDateString("en-GB", full)}`;
}

/**
 * One week's badge in the History month view — same visual language as
 * WeeklyHabitBadge on Progress's Streaks section (HISTORY PRD), but over a
 * week's range label instead of a habit name, since this screen already
 * shows one habit at a time.
 */
function HistoryWeekBadge({ week }: { week: HistoryWeek }) {
  const range = weekRangeLabel(week.weekStart, week.weekEnd);
  const label = `Week of ${range}: ${
    week.met ? `marked on ${week.count} day${week.count === 1 ? "" : "s"}` : "not marked"
  }`;

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-xl border px-3 py-3",
        week.met ? "border-accent/40 bg-accent/10" : "border-dashed border-border/70 bg-surface-2"
      )}
      aria-label={label}
      title={label}
    >
      <div
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
          week.met ? "bg-accent/20" : "bg-surface-3"
        )}
      >
        {week.met ? (
          <span className="text-body numeric font-semibold text-accent">{week.count}</span>
        ) : (
          <Flame className="h-4 w-4 text-quaternary" strokeWidth={1.5} aria-hidden="true" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-footnote font-semibold text-foreground">{range}</p>
        <p className="text-caption text-muted-foreground">
          {week.met ? `${week.count}× this week` : "Not marked"}
        </p>
      </div>
    </div>
  );
}

function SummaryLine({ data }: { data: HistoryMonthResponse }) {
  const points =
    data.totalPoints !== undefined ? (
      <span>
        <span className="font-semibold text-foreground">{data.totalPoints.toLocaleString()}</span> pts this month
      </span>
    ) : null;

  if (data.period === "daily") {
    return (
      <p className="text-footnote text-muted-foreground">
        <span className="font-semibold text-foreground">
          {data.completedCount} of {data.applicableDays}
        </span>{" "}
        days
        {points && <> · {points}</>}
      </p>
    );
  }

  return points ? <p className="text-footnote text-muted-foreground">{points}</p> : null;
}

function EmptyHistoryState({
  isAdmin,
  onNavigateAway,
}: {
  isAdmin: boolean;
  onNavigateAway: (tab: "log" | "admin") => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-3 text-muted-foreground">
        <CalendarDays className="h-6 w-6" aria-hidden="true" />
      </div>
      <p className="text-body font-semibold text-foreground">No habits yet</p>
      <p className="max-w-xs text-footnote text-muted-foreground">
        {isAdmin
          ? "There's no history until your room has a habit to track."
          : "There's no history until you have a habit to track — add one of your own."}
      </p>
      <Button type="button" variant="outline" onClick={() => onNavigateAway(isAdmin ? "admin" : "log")}>
        {isAdmin ? "Go to Admin" : "Go to Log"}
      </Button>
    </div>
  );
}

export default function HistoryScreen({ initData, isAdmin, onBack, onNavigateAway }: Props) {
  const [habitsList, setHabitsList] = useState<HistoryHabitListEntry[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<HistoryHabitListEntry | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const [data, setData] = useState<HistoryMonthResponse | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const [dataLoading, setDataLoading] = useState(false);
  const [retryToken, setRetryToken] = useState(0);

  // Loads the switcher list once, then restores the last-viewed habit and
  // month (localStorage — HISTORY PRD makes no server-side change for this),
  // falling back to the first habit and the current month on a first-ever
  // open, or when the saved habit no longer exists (a personal habit can be
  // hard-deleted, unlike a room habit).
  useEffect(() => {
    let cancelled = false;
    getHistoryHabits(initData)
      .then((list) => {
        if (cancelled) return;
        setHabitsList(list);
        if (list.length === 0) return;
        const saved = loadLastHabit();
        const restored = saved
          ? list.find((h) => h.kind === saved.kind && h.id === saved.habitId)
          : undefined;
        setSelected(restored ?? list[0]!);
        setMonth(loadLastMonth() ?? currentMonthKey());
      })
      .catch((err) => {
        if (!cancelled) setListError(messageForApiError(err, "Couldn't load your habits."));
      });
    return () => {
      cancelled = true;
    };
  }, [initData]);

  useEffect(() => {
    if (selected === null || month === null) return;
    let cancelled = false;
    setDataLoading(true);
    setDataError(null);
    getHistoryMonth(initData, selected.kind, selected.id, month)
      .then((loaded) => {
        if (!cancelled) setData(loaded);
      })
      .catch((err) => {
        if (!cancelled) setDataError(messageForApiError(err, "Couldn't load that month."));
      })
      .finally(() => {
        if (!cancelled) setDataLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [initData, selected, month, retryToken]);

  function handleSelectHabit(habit: HistoryHabitListEntry) {
    setSelected(habit);
    saveLastHabit({ kind: habit.kind, habitId: habit.id });
    // Month deliberately stays as-is (HISTORY PRD) — only habit selection changes here.
  }

  function handleMonthChange(next: string) {
    setMonth(next);
    saveLastMonth(next);
  }

  const canGoPrev = data !== null && month !== null && month > data.earliestMonth;
  const canGoNext = data !== null && month !== null && month < data.today.slice(0, 7);

  return (
    <div className="mx-auto max-w-sm space-y-4 px-4 py-6">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onBack}
          aria-label="Back to Progress"
          className="-ml-2"
        >
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <h2 className="text-title text-foreground">History</h2>
      </div>

      {listError && <p className="text-body text-destructive">{listError}</p>}

      {!listError && habitsList === null && (
        <p className="text-footnote text-muted-foreground">Loading…</p>
      )}

      {!listError && habitsList !== null && habitsList.length === 0 && (
        <EmptyHistoryState isAdmin={isAdmin} onNavigateAway={onNavigateAway} />
      )}

      {!listError && habitsList !== null && habitsList.length > 0 && selected !== null && month !== null && (
        <>
          <HistoryHabitPicker habits={habitsList} selected={selected} onSelect={handleSelectHabit} />

          <div className="flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Previous month"
              disabled={!canGoPrev}
              onClick={() => handleMonthChange(shiftMonthKey(month, -1))}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <p className="text-body font-semibold text-foreground">{formatMonthLabel(month)}</p>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Next month"
              disabled={!canGoNext}
              onClick={() => handleMonthChange(shiftMonthKey(month, 1))}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>

          {dataError && (
            <div className="space-y-2">
              <p className="text-body text-destructive">{dataError}</p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setRetryToken((t) => t + 1)}
              >
                Retry
              </Button>
            </div>
          )}

          {!dataError && dataLoading && <p className="text-footnote text-muted-foreground">Loading…</p>}

          {!dataError && !dataLoading && data !== null && !data.hasData && (
            <p className="text-footnote text-muted-foreground">No data this month.</p>
          )}

          {!dataError && !dataLoading && data !== null && data.hasData && (
            <div className="space-y-3">
              {data.period === "daily" ? (
                <HistoryCalendarGrid days={data.days} today={data.today} />
              ) : (
                <div className="space-y-2">
                  {data.weeks.map((week) => (
                    <HistoryWeekBadge key={week.weekStart} week={week} />
                  ))}
                </div>
              )}
              <SummaryLine data={data} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
