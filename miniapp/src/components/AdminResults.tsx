import { useCallback, useEffect, useState } from "react";
import { Download, RefreshCw, Trophy } from "lucide-react";
import {
  downloadAdminExport,
  getAdminLeaderboard,
} from "../api/client.ts";
import { messageForApiError } from "../api/errors.ts";
import type {
  AdminLeaderboardResponse,
  LeaderboardPeriod,
} from "../api/types.ts";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface Props {
  initData: string;
  mawlidStartDate: string;
  mawlidEndDate: string;
}

export default function AdminResults({
  initData,
  mawlidStartDate,
  mawlidEndDate,
}: Props) {
  const [period, setPeriod] = useState<LeaderboardPeriod>("all");
  const [data, setData] = useState<AdminLeaderboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await getAdminLeaderboard(initData, period));
    } catch (err) {
      setError(messageForApiError(err, "Couldn't load leaderboard results."));
    } finally {
      setLoading(false);
    }
  }, [initData, period]);

  useEffect(() => {
    void load();
  }, [load]);

  async function downloadCsv(): Promise<void> {
    if (downloading) return;
    setDownloading(true);
    setError(null);
    try {
      const blob = await downloadAdminExport(initData, period);
      const filename =
        period === "mawlid"
          ? `salawat-leaderboard-mawlid-${mawlidStartDate}-to-${mawlidEndDate}.csv`
          : `salawat-leaderboard-all-time-${new Date().toISOString().slice(0, 10)}.csv`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(messageForApiError(err, "Couldn't download the CSV."));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle>Leaderboard Results</CardTitle>
            <CardDescription>
              Live totals from the current database.
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => void load()}
            disabled={loading}
            aria-label="Refresh leaderboard results"
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div
          role="tablist"
          aria-label="Leaderboard period"
          className="grid grid-cols-2 gap-1 rounded-lg bg-secondary/60 p-1"
        >
          {(["all", "mawlid"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={period === value}
              onClick={() => setPeriod(value)}
              className={cn(
                "min-h-11 rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                period === value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {value === "all" ? "All-time" : "Mawlid"}
            </button>
          ))}
        </div>

        <div className="rounded-lg bg-secondary/35 px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {period === "all"
              ? "All-time jamaat total"
              : `Mawlid · ${mawlidStartDate} → ${mawlidEndDate}`}
          </p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
            {loading ? "…" : (data?.jamaatTotal ?? 0).toLocaleString()}
          </p>
        </div>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        {!loading && data && (
          <div className="divide-y rounded-lg border">
            {data.leaderboard.length === 0 ? (
              <p className="px-3 py-5 text-center text-sm text-muted-foreground">
                No participants yet.
              </p>
            ) : (
              data.leaderboard.map((entry) => (
                <div
                  key={`${entry.rank}-${entry.nickname}`}
                  className="flex items-center gap-3 px-3 py-2.5"
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary text-sm font-semibold tabular-nums text-secondary-foreground">
                    {entry.rank}
                  </div>
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {entry.nickname}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {entry.realName?.trim() ? entry.realName : "—"}
                    </span>
                  </div>
                  <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                    {entry.total.toLocaleString()}
                  </span>
                </div>
              ))
            )}
          </div>
        )}

        <Button
          type="button"
          variant="outline"
          className="min-h-11 w-full"
          disabled={loading || downloading || !data}
          onClick={() => void downloadCsv()}
        >
          {downloading ? (
            <RefreshCw className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          {downloading
            ? "Preparing CSV…"
            : `Download ${period === "all" ? "all-time" : "Mawlid"} CSV`}
        </Button>

        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Trophy className="h-3.5 w-3.5" aria-hidden="true" />
          Ties share the same competition rank.
        </p>
      </CardContent>
    </Card>
  );
}
