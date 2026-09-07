import { useState } from "react";
import { MoonStar, Settings } from "lucide-react";
import { putDayOverride } from "../api/client.ts";
import { messageForApiError } from "../api/errors.ts";
import type { DayBreakdown, RegisteredProgress } from "../api/types.ts";
import VirtueReminder from "../components/VirtueReminder.tsx";
import { daysLeftCopy } from "../lib/challengeCopy.ts";
import { formatHijriDate } from "../lib/hijriDate.ts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

interface Props {
  progress: RegisteredProgress;
  initData: string;
  onOpenSettings: () => void;
  /** Merge streak + last7Days after a successful day override. */
  onDayOverride: (update: { streak: number; last7Days: DayBreakdown[] }) => void;
}

function streakCopy(streak: number): string {
  if (streak <= 0) return "No streak yet";
  return `🔥 ${streak} day${streak === 1 ? "" : "s"} streak`;
}

function weekdayLabel(date: string): string {
  // Parse as UTC noon to avoid local TZ shifting the calendar day.
  const d = new Date(`${date}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { weekday: "narrow", timeZone: "UTC" });
}

function shortDateLabel(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function todayPercent(todayTotal: number, dailyGoal: number): number {
  if (dailyGoal <= 0) return 0;
  return Math.min(100, Math.round((todayTotal / dailyGoal) * 1000) / 10);
}

/** Most recent missed past day in last7Days (closest to today), or null. */
function mostRecentMissedPastDay(days: DayBreakdown[]): DayBreakdown | null {
  if (days.length === 0) return null;
  // oldest → newest; skip today (last index) and locked (pre-registration) days
  for (let i = days.length - 2; i >= 0; i--) {
    const day = days[i]!;
    if (day.locked) continue;
    if (!day.metGoal) return day;
  }
  return null;
}

function dotClass(day: DayBreakdown, isToday: boolean): string {
  if (isToday || day.locked) {
    return day.metGoal
      ? "h-3.5 w-3.5 rounded-full bg-primary"
      : "h-3.5 w-3.5 rounded-full border-2 border-muted-foreground/40 bg-transparent";
  }
  return day.metGoal
    ? "h-3.5 w-3.5 rounded-full bg-primary"
    : "h-3.5 w-3.5 rounded-full bg-destructive";
}

interface WeekTrackerProps {
  days: DayBreakdown[];
  busyDate: string | null;
  onTogglePast: (day: DayBreakdown) => void;
}

function WeekTracker({ days, busyDate, onTogglePast }: WeekTrackerProps) {
  const todayDate = days.length > 0 ? days[days.length - 1]!.date : null;

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-foreground">Last 7 days</p>
      <div className="flex justify-between gap-1 px-1">
        {days.map((day) => {
          const isToday = day.date === todayDate;
          const label = `${day.date}: ${day.total.toLocaleString()}${
            day.locked
              ? " (not applicable)"
              : day.metGoal
                ? " (goal met)"
                : isToday
                  ? " (in progress)"
                  : " (missed)"
          }`;

          if (isToday || day.locked) {
            return (
              <div key={day.date} className="flex flex-1 flex-col items-center gap-1.5">
                <span
                  className={dotClass(day, isToday)}
                  title={label}
                  aria-label={label}
                />
                <span className="text-xs text-muted-foreground">{weekdayLabel(day.date)}</span>
              </div>
            );
          }

          return (
            <div key={day.date} className="flex flex-1 flex-col items-center gap-1.5">
              <button
                type="button"
                disabled={busyDate !== null}
                onClick={() => onTogglePast(day)}
                className="touch-manipulation rounded-full p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                title={label}
                aria-label={`${label}. Tap to mark ${day.metGoal ? "missed" : "complete"}.`}
              >
                <span className={dotClass(day, false)} />
              </button>
              <span className="text-xs text-muted-foreground">{weekdayLabel(day.date)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function ProgressScreen({
  progress,
  initData,
  onOpenSettings,
  onDayOverride,
}: Props) {
  const { nickname, total, todayTotal, dailyGoal, streak, last7Days } = progress;
  const percent = todayPercent(todayTotal, dailyGoal);
  const hijriLabel = formatHijriDate();
  const days = last7Days ?? [];
  const missed = mostRecentMissedPastDay(days);

  const [busyDate, setBusyDate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function setDayMet(date: string, met: boolean) {
    if (busyDate) return;
    setBusyDate(date);
    setError(null);

    const prevDays = days;
    const prevStreak = streak;
    // Optimistic: flip only the tapped day.
    const optimisticDays = days.map((d) => (d.date === date ? { ...d, metGoal: met } : d));
    onDayOverride({ streak: prevStreak, last7Days: optimisticDays });

    try {
      const result = await putDayOverride(initData, date, met);
      onDayOverride({ streak: result.streak, last7Days: result.last7Days });
    } catch (err) {
      onDayOverride({ streak: prevStreak, last7Days: prevDays });
      setError(messageForApiError(err, "Couldn't update that day."));
    } finally {
      setBusyDate(null);
    }
  }

  return (
    <div className="mx-auto max-w-sm space-y-4 px-4 py-6">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <CardTitle className="text-2xl font-bold tracking-tight">
              <span className={streak > 0 ? "text-foreground" : "text-muted-foreground"}>
                {streakCopy(streak)}
              </span>
            </CardTitle>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onOpenSettings}
              aria-label="Open settings"
              className="-mr-2 -mt-1"
            >
              <Settings className="h-5 w-5" />
            </Button>
          </div>
          <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-accent/10 px-2.5 py-1 text-xs font-medium text-[#854d0e] dark:bg-accent/15 dark:text-[#e6bf6a]">
            <MoonStar className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {hijriLabel}
          </span>
          <CardDescription>Keep it up, {nickname}!</CardDescription>
        </CardHeader>

        <CardContent className="space-y-6">
          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium text-foreground">Today</span>
              <span className="text-sm text-muted-foreground">
                <span className="font-semibold tabular-nums text-foreground">
                  {todayTotal.toLocaleString()}
                </span>
                {" / "}
                {dailyGoal.toLocaleString()}
              </span>
            </div>
            <Progress value={percent} />
            <p className="text-sm text-muted-foreground">{percent}% of daily goal</p>
          </div>

          {missed && (
            <button
              type="button"
              disabled={busyDate !== null}
              onClick={() => void setDayMet(missed.date, true)}
              className="w-full rounded-lg bg-destructive/10 px-3 py-2.5 text-left text-sm text-destructive touch-manipulation focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            >
              You missed {shortDateLabel(missed.date)} — you can still make it up! Tap to mark it
              complete.
            </button>
          )}

          <WeekTracker
            days={days}
            busyDate={busyDate}
            onTogglePast={(day) => void setDayMet(day.date, !day.metGoal)}
          />

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="space-y-2 border-t border-border pt-4">
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-muted-foreground">All-time</span>
              <span className="tabular-nums text-muted-foreground">{total.toLocaleString()}</span>
            </div>
            <p className="text-sm text-muted-foreground">{daysLeftCopy(progress)}</p>
          </div>
        </CardContent>
      </Card>

      <VirtueReminder />
    </div>
  );
}
