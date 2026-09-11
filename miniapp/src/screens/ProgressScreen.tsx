import { useEffect, useState } from "react";
import { MoonStar, Settings, Users } from "lucide-react";
import { getProgressWeek } from "../api/client.ts";
import { messageForApiError } from "../api/errors.ts";
import type { Habit, RegisteredProgress, WeeklyProgressResponse } from "../api/types.ts";
import StreakBadge from "../components/StreakBadge.tsx";
import WeeklyStreakGrid from "../components/WeeklyStreakGrid.tsx";
import VirtueReminder from "../components/VirtueReminder.tsx";
import { formatHijriDate } from "../lib/hijriDate.ts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface Props {
  initData: string;
  progress: RegisteredProgress;
  habits: Habit[] | null;
  onOpenSettings: () => void;
}

function habitLabel(habits: Habit[] | null, habitId: number): string {
  return habits?.find((h) => h.id === habitId)?.name ?? `Habit #${habitId}`;
}

export default function ProgressScreen({ initData, progress, habits, onOpenSettings }: Props) {
  const { nickname, totalPoints, todayPoints, streaks, streakDisplay, weekStartDay, room } =
    progress;
  const hijriLabel = formatHijriDate();

  const [week, setWeek] = useState<WeeklyProgressResponse | null>(null);
  const [weekError, setWeekError] = useState<string | null>(null);

  // Only the weekly shape needs the week endpoint; the current-streak shape
  // reads the streaks GET /api/progress already returned. Switching display is
  // therefore at most one extra request and never a recomputation of anything.
  useEffect(() => {
    if (streakDisplay !== "weekly") return;
    let cancelled = false;
    setWeekError(null);
    void getProgressWeek(initData)
      .then((loaded) => {
        if (!cancelled) setWeek(loaded);
      })
      .catch((err) => {
        if (!cancelled) setWeekError(messageForApiError(err, "Couldn't load this week."));
      });
    return () => {
      cancelled = true;
    };
  }, [initData, streakDisplay, weekStartDay]);

  return (
    <div className="mx-auto max-w-sm space-y-4 px-4 py-6">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <CardTitle className="text-2xl font-bold tracking-tight">Progress</CardTitle>
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
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-accent/10 px-2.5 py-1 text-xs font-medium text-[#854d0e] dark:bg-accent/15 dark:text-[#e6bf6a]">
              <MoonStar className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {hijriLabel}
            </span>
            {/* Which room these points belong to (PRD §3a). */}
            {room && (
              <span className="inline-flex w-fit max-w-full items-center gap-1.5 rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground">
                <Users className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{room.name}</span>
              </span>
            )}
          </div>
          <CardDescription>Keep it up, {nickname}!</CardDescription>
        </CardHeader>

        <CardContent className="space-y-6">
          {/*
            Today's total lives here and only here: it is a personal figure, and
            the leaderboard deliberately has no counterpart to it — there is no
            group total anywhere in the app.
          */}
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg bg-secondary/40 px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Today
              </p>
              <p className="text-xl font-semibold tabular-nums text-foreground">
                {todayPoints.toLocaleString()}
              </p>
            </div>
            <div className="rounded-lg bg-secondary/40 px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                All-time
              </p>
              <p className="text-xl font-semibold tabular-nums text-foreground">
                {totalPoints.toLocaleString()}
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">Streaks</p>
            {streakDisplay === "weekly" ? (
              weekError ? (
                <p className="text-sm text-destructive">{weekError}</p>
              ) : week ? (
                <WeeklyStreakGrid week={week} />
              ) : (
                <p className="text-sm text-muted-foreground">Loading…</p>
              )
            ) : streaks.length === 0 ? (
              <p className="text-sm text-muted-foreground">No habits yet.</p>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {streaks.map((s) => (
                  <StreakBadge
                    key={s.habitId}
                    habitName={habitLabel(habits, s.habitId)}
                    streak={s.streak}
                  />
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <VirtueReminder />
    </div>
  );
}
