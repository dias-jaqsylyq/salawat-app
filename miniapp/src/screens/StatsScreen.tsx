import { useCallback, useEffect, useState } from "react";
import { Sprout, Trophy, Users, UsersRound } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { getStats } from "../api/client.ts";
import { messageForApiError } from "../api/errors.ts";
import type { StatsHabit, StatsResponse } from "../api/types.ts";
import CategoryHeading from "../components/CategoryHeading.tsx";
import MiniBarChart from "../components/MiniBarChart.tsx";
import { formatAmount, formatNumber } from "../lib/formatAmount.ts";
import { groupHabitsByCategory } from "../lib/habitCategories.ts";
import { shortDate } from "../lib/statsChart.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { StatTile } from "@/components/ui/stat-tile";
import { cn } from "@/lib/utils";

interface Props {
  initData: string;
}

/** "1 Sep 2026" for the room's creation day. */
function sinceLabel(date: string): string {
  return `since ${shortDate(date)} ${date.slice(0, 4)}`;
}

function HabitStatsCard({ habit, weekStarts }: { habit: StatsHabit; weekStarts: string[] }) {
  const showEstimate = habit.completions > 0 && habit.estimatedAmount !== null && habit.unit !== null;
  return (
    <Card className={cn(!habit.active && "bg-surface-2 shadow-none")}>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <h4
              className={cn(
                "truncate text-body font-semibold",
                habit.active ? "text-foreground" : "text-muted-foreground"
              )}
            >
              {habit.name}
            </h4>
            <p className="text-footnote text-muted-foreground">
              <span className="numeric font-bold text-foreground">{formatNumber(habit.completions)}</span>{" "}
              {habit.completions === 1 ? "completion" : "completions"}
              {showEstimate && <> · {formatAmount(habit.estimatedAmount!, habit.unit!)}</>}
            </p>
          </div>
          {!habit.active && <Badge size="sm">Paused</Badge>}
        </div>
        <MiniBarChart
          weekly={habit.weekly}
          weekStarts={weekStarts}
          currentWeekIndex={habit.currentWeekIndex}
          bestWeekIndex={habit.bestWeekIndex}
          muted={!habit.active}
        />
      </CardContent>
    </Card>
  );
}

/**
 * What the whole room has done together, all time — every figure an aggregate
 * over the room, so there is nothing personal here: no names, no ranking, no
 * "your share". Members who left still count; personal habits never do.
 *
 * Read-only. Habits follow the Log screen's order and grouping (by category
 * when the room uses them), paused ones included, muted.
 */
export default function StatsScreen({ initData }: Props) {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getStats(initData)
      .then(setStats)
      .catch((err) => setError(messageForApiError(err, "Couldn't load the room's stats.")))
      .finally(() => setLoading(false));
  }, [initData]);

  // Remount when the Stats tab is opened → fresh numbers.
  useEffect(() => {
    load();
  }, [load]);

  const room = stats?.room ?? null;
  const habits = stats?.habits ?? [];
  const hasActivity = habits.some((habit) => habit.completions > 0);
  const hasEstimates = habits.some((habit) => habit.completions > 0 && habit.estimatedAmount !== null);
  const groups = stats?.categoriesEnabled ? groupHabitsByCategory(habits) : null;
  const weekStarts = stats?.weekStarts ?? [];

  return (
    <div className="mx-auto max-w-sm space-y-4 px-4 py-6">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-title text-foreground">
          <Icon icon={UsersRound} size="md" className="text-primary" />
          Stats
        </h2>
        <p className="mt-1 text-footnote text-muted-foreground">
          What the room has done together{room ? `, ${sinceLabel(room.since)}` : ""}
        </p>
      </div>

      {error && (
        <div className="space-y-2">
          <p className="text-body text-destructive animate-reveal">{error}</p>
          <Button type="button" variant="secondary" size="sm" onClick={load}>
            Retry
          </Button>
        </div>
      )}

      {!error && (loading || room !== null) && (
        <div className="grid grid-cols-2 gap-3">
          <StatTile label="Members" icon={Users} value={room?.memberCount ?? 0} loading={loading && !room} />
          <StatTile
            label="Room points"
            icon={Trophy}
            tone="brand"
            value={room?.totalPoints ?? 0}
            loading={loading && !room}
          />
        </div>
      )}

      {loading && !stats && (
        <div className="space-y-3">
          <Skeleton shape="block" className="h-32 w-full" />
          <Skeleton shape="block" className="h-32 w-full" />
        </div>
      )}

      {!error && stats && !hasActivity && (
        <Card>
          <EmptyState
            icon={Sprout}
            title="Nothing logged yet"
            description="Once the room starts marking habits, everything you do together adds up here."
          />
        </Card>
      )}

      {!error && stats && hasActivity && groups !== null &&
        groups.map((group) => (
          <section key={group.category ?? "uncategorized"} className="space-y-2">
            <CategoryHeading category={group.category} />
            {group.habits.map((habit) => (
              <HabitStatsCard key={habit.id} habit={habit} weekStarts={weekStarts} />
            ))}
          </section>
        ))}

      {!error && stats && hasActivity && groups === null && (
        <div className="space-y-3">
          {habits.map((habit) => (
            <HabitStatsCard key={habit.id} habit={habit} weekStarts={weekStarts} />
          ))}
        </div>
      )}

      {!error && stats && hasEstimates && (
        <p className="px-1 text-caption text-muted-foreground">
          Amounts are estimates from each habit's set amount per completion — the real total is at
          least this much.
        </p>
      )}
    </div>
  );
}
