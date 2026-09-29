import { useEffect, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Flame } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { getHistoryHabits, getHistoryMonth } from "../api/client.ts";
import { messageForApiError } from "../api/errors.ts";
import type { HistoryHabitListEntry, HistoryMonthResponse, HistoryWeek } from "../api/types.ts";
import HistoryCalendarGrid from "../components/HistoryCalendarGrid.tsx";
import HistoryHabitPicker from "../components/HistoryHabitPicker.tsx";
import { loadLastHabit, loadLastMonth, saveLastHabit, saveLastMonth } from "../lib/historyPrefs.ts";
import { currentMonthKey, formatMonthLabel, shiftMonthKey } from "../lib/monthKey.ts";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SwipePager } from "../components/motion/SwipePager.tsx";
import { hapticSelection } from "../lib/haptics.ts";
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
          <Icon icon={Flame} className="text-quaternary" />
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

function habitCacheKey(habit: HistoryHabitListEntry): string {
  return `${habit.kind}:${habit.id}`;
}

function monthCacheKey(habit: HistoryHabitListEntry, month: string): string {
  return `${habitCacheKey(habit)}:${month}`;
}

/** A month-shaped placeholder, so the page slides in at its real size while it loads. */
function MonthSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading month">
      <div className="grid grid-cols-7 gap-2">
        {Array.from({ length: 35 }, (_, i) => (
          <Skeleton key={i} shape="block" className="aspect-square" />
        ))}
      </div>
      <Skeleton className="w-40" />
    </div>
  );
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
        <Icon icon={CalendarDays} size="lg" />
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
  /** Which way the calendar last paged, for the slide: 1 forward, -1 back, 0 not a page turn. */
  const [direction, setDirection] = useState(0);
  /**
   * Months already fetched this visit, so paging back and forth is instant and
   * the slide never lands on a spinner twice. Per mount: reopening History
   * fetches fresh, picking up anything logged in between.
   */
  const cache = useRef(new Map<string, HistoryMonthResponse>());
  const [, setCacheVersion] = useState(0);
  const [dataError, setDataError] = useState<string | null>(null);
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

  const pageKey = selected !== null && month !== null ? monthCacheKey(selected, month) : null;
  const data = pageKey !== null ? cache.current.get(pageKey) : undefined;

  useEffect(() => {
    if (selected === null || month === null) return;
    const key = monthCacheKey(selected, month);
    setDataError(null);
    if (cache.current.has(key)) return;
    let cancelled = false;
    getHistoryMonth(initData, selected.kind, selected.id, month)
      .then((loaded) => {
        cache.current.set(key, loaded);
        if (!cancelled) setCacheVersion((v) => v + 1);
      })
      .catch((err) => {
        if (!cancelled) setDataError(messageForApiError(err, "Couldn't load that month."));
      });
    return () => {
      cancelled = true;
    };
  }, [initData, selected, month, retryToken]);

  // Paging back is the common move, so the previous month is fetched quietly
  // once this one is in, ready before the swipe that asks for it.
  const earliestMonth = data?.earliestMonth;
  useEffect(() => {
    if (selected === null || month === null || earliestMonth === undefined || month <= earliestMonth) return;
    const previous = shiftMonthKey(month, -1);
    const key = monthCacheKey(selected, previous);
    if (cache.current.has(key)) return;
    getHistoryMonth(initData, selected.kind, selected.id, previous)
      .then((loaded) => {
        cache.current.set(key, loaded);
      })
      .catch(() => {
        // Only a head start; the real request retries when that month is shown.
      });
  }, [initData, selected, month, earliestMonth]);

  /**
   * Paging limits come from the last month loaded for this habit, so the arrows
   * and swipe keep working while the next page is still loading.
   */
  const bounds = useRef<{ habitKey: string; earliestMonth: string; currentMonth: string } | null>(null);
  if (data && selected !== null) {
    bounds.current = {
      habitKey: habitCacheKey(selected),
      earliestMonth: data.earliestMonth,
      currentMonth: data.today.slice(0, 7),
    };
  }
  const limits =
    selected !== null && bounds.current?.habitKey === habitCacheKey(selected) ? bounds.current : null;

  function handleSelectHabit(habit: HistoryHabitListEntry) {
    setDirection(0);
    setSelected(habit);
    saveLastHabit({ kind: habit.kind, habitId: habit.id });
    // Month deliberately stays as-is (HISTORY PRD) — only habit selection changes here.
  }

  function handleMonthChange(step: -1 | 1) {
    if (month === null) return;
    const next = shiftMonthKey(month, step);
    setDirection(step);
    setMonth(next);
    saveLastMonth(next);
  }

  const canGoPrev = limits !== null && month !== null && month > limits.earliestMonth;
  const canGoNext = limits !== null && month !== null && month < limits.currentMonth;

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
          <Icon icon={ChevronLeft} size="md" />
        </Button>
        <h2 className="text-title text-foreground">History</h2>
      </div>

      {listError && <p className="text-body text-destructive animate-reveal">{listError}</p>}

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
              onClick={() => handleMonthChange(-1)}
            >
              <Icon icon={ChevronLeft} />
            </Button>
            <p className="text-body font-semibold text-foreground">{formatMonthLabel(month)}</p>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Next month"
              disabled={!canGoNext}
              onClick={() => handleMonthChange(1)}
            >
              <Icon icon={ChevronRight} />
            </Button>
          </div>

          {dataError ? (
            <div className="space-y-2">
              <p className="text-body text-destructive animate-reveal">{dataError}</p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setRetryToken((t) => t + 1)}
              >
                Retry
              </Button>
            </div>
          ) : (
            <SwipePager
              pageKey={pageKey ?? month}
              direction={direction}
              canPrev={canGoPrev}
              canNext={canGoNext}
              onPage={(step) => {
                hapticSelection();
                handleMonthChange(step);
              }}
            >
              {data === undefined ? (
                <MonthSkeleton />
              ) : !data.hasData ? (
                <p className="text-footnote text-muted-foreground">No data this month.</p>
              ) : (
                <div className="space-y-3 animate-fade">
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
            </SwipePager>
          )}
        </>
      )}
    </div>
  );
}
