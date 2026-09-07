import { useCallback, useEffect, useState } from "react";
import { Trophy } from "lucide-react";
import { getLeaderboard } from "../api/client.ts";
import { messageForApiError } from "../api/errors.ts";
import type { LeaderboardEntry, RegisteredProgress } from "../api/types.ts";
import { daysLeftCopy } from "../lib/challengeCopy.ts";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  initData: string;
  progress: Pick<RegisteredProgress, "challengeStatus" | "challengeEndDate" | "daysLeft">;
}

function rankBadgeVariant(rank: number): "gold" | "silver" | "bronze" | "outline" {
  if (rank === 1) return "gold";
  if (rank === 2) return "silver";
  if (rank === 3) return "bronze";
  return "outline";
}

function rankRowTint(rank: number): string {
  if (rank === 1) return "bg-amber-50/80 dark:bg-amber-950/30";
  if (rank === 2) return "bg-slate-100/80 dark:bg-slate-800/40";
  if (rank === 3) return "bg-orange-50/80 dark:bg-orange-950/25";
  return "";
}

function isTied(entries: LeaderboardEntry[], entry: LeaderboardEntry): boolean {
  return entries.some((other) => other !== entry && other.rank === entry.rank);
}

export default function LeaderboardScreen({ initData, progress }: Props) {
  const [entries, setEntries] = useState<LeaderboardEntry[] | null>(null);
  const [jamaatTotal, setJamaatTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    setEntries(null);
    setJamaatTotal(null);
    getLeaderboard(initData)
      .then(({ leaderboard, jamaatTotal: total }) => {
        setEntries(leaderboard);
        setJamaatTotal(total);
      })
      .catch((err) => {
        setError(messageForApiError(err, "Couldn't load the leaderboard."));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [initData]);

  // Remount when the Leaderboard tab is opened → fresh jamaatTotal + rows.
  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="mx-auto max-w-sm space-y-4 px-4 py-6">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
        <Trophy className="h-5 w-5 text-accent" aria-hidden="true" />
        Leaderboard
      </h2>

      <div className="space-y-2 rounded-lg bg-secondary/40 px-4 py-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Jamaat total
        </p>
        <p className="text-xl font-semibold tabular-nums text-foreground">
          {loading || jamaatTotal === null
            ? "…"
            : `${jamaatTotal.toLocaleString()} salawat`}
        </p>
      </div>

      <div className="rounded-lg bg-muted px-4 py-3 text-sm text-muted-foreground">
        {daysLeftCopy(progress)}
      </div>

      {error && (
        <div className="space-y-2">
          <p className="text-sm text-destructive">{error}</p>
          <Button type="button" variant="secondary" size="sm" onClick={load}>
            Retry
          </Button>
        </div>
      )}

      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {!loading && !error && entries !== null && entries.length === 0 && (
        <p className="text-sm text-muted-foreground">No one's registered yet.</p>
      )}

      {!loading && !error && entries !== null && entries.length > 0 && (
        <Card>
          <CardContent className="divide-y p-0">
            {entries.map((entry, index) => (
              <div
                key={`${entry.rank}-${entry.nickname}-${index}`}
                className={cn(
                  "flex items-center justify-between px-4 py-3",
                  rankRowTint(entry.rank),
                  entry.isYou && "border-l-2 border-primary",
                  entry.isYou && entry.rank > 3 && "bg-primary/5"
                )}
              >
                <span className="flex items-center gap-3 text-sm font-medium text-foreground">
                  <Badge variant={rankBadgeVariant(entry.rank)} className="w-7 justify-center">
                    {entry.rank}
                  </Badge>
                  <span className="flex flex-col">
                    <span>
                      {entry.nickname}
                      {entry.isYou ? " (You)" : ""}
                    </span>
                    {isTied(entries, entry) && (
                      <span className="text-xs font-normal text-muted-foreground">tied</span>
                    )}
                  </span>
                </span>
                <span className="text-sm tabular-nums text-muted-foreground">
                  {entry.total.toLocaleString()}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
