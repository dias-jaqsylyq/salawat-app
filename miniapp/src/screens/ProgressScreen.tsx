import { MoonStar, Settings } from "lucide-react";
import type { Habit, RegisteredProgress } from "../api/types.ts";
import VirtueReminder from "../components/VirtueReminder.tsx";
import { formatHijriDate } from "../lib/hijriDate.ts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface Props {
  progress: RegisteredProgress;
  habits: Habit[] | null;
  onOpenSettings: () => void;
}

function habitLabel(habits: Habit[] | null, habitId: number): string {
  return habits?.find((h) => h.id === habitId)?.name ?? `Habit #${habitId}`;
}

function streakCopy(streak: number): string {
  if (streak <= 0) return "No streak yet";
  return `🔥 ${streak} day${streak === 1 ? "" : "s"}`;
}

export default function ProgressScreen({ progress, habits, onOpenSettings }: Props) {
  const { nickname, totalPoints, jamaatTotal, streaks } = progress;
  const hijriLabel = formatHijriDate();

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
          <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-accent/10 px-2.5 py-1 text-xs font-medium text-[#854d0e] dark:bg-accent/15 dark:text-[#e6bf6a]">
            <MoonStar className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {hijriLabel}
          </span>
          <CardDescription>Keep it up, {nickname}!</CardDescription>
        </CardHeader>

        <CardContent className="space-y-6">
          <div className="grid grid-cols-2 gap-3 rounded-lg bg-secondary/40 px-4 py-3">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                All-time total
              </p>
              <p className="text-xl font-semibold tabular-nums text-foreground">
                {totalPoints.toLocaleString()}
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Jamaat total
              </p>
              <p className="text-xl font-semibold tabular-nums text-foreground">
                {jamaatTotal.toLocaleString()}
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">Streaks</p>
            {streaks.length === 0 ? (
              <p className="text-sm text-muted-foreground">No habits yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {streaks.map((s) => (
                  <li
                    key={s.habitId}
                    className="flex items-center justify-between text-sm"
                  >
                    <span className="text-foreground">{habitLabel(habits, s.habitId)}</span>
                    <span className={s.streak > 0 ? "text-foreground" : "text-muted-foreground"}>
                      {streakCopy(s.streak)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      <VirtueReminder />
    </div>
  );
}
