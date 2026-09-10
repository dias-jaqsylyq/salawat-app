import { useCallback, useEffect, useState } from "react";
import { Download, RefreshCw, Trophy } from "lucide-react";
import { downloadAdminExport, getAdminLeaderboard } from "../api/client.ts";
import { messageForApiError } from "../api/errors.ts";
import type { AdminLeaderboardResponse } from "../api/types.ts";
import AdminParticipantRow from "./AdminParticipantRow.tsx";
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
  /** Names the CSV file after the room, so exports from several rooms stay apart. */
  roomName: string | null;
  /** Bubbled up when the caller demotes themselves — see AdminScreen. */
  onAdminStatusChanged: () => void;
}

export default function AdminResults({ initData, roomName, onAdminStatusChanged }: Props) {
  const [data, setData] = useState<AdminLeaderboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await getAdminLeaderboard(initData));
    } catch (err) {
      setError(messageForApiError(err, "Couldn't load leaderboard results."));
    } finally {
      setLoading(false);
    }
  }, [initData]);

  useEffect(() => {
    void load();
  }, [load]);

  async function downloadCsv(): Promise<void> {
    if (downloading) return;
    setDownloading(true);
    setError(null);
    try {
      const blob = await downloadAdminExport(initData);
      const slug = roomName
        ? roomName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
        : "";
      const filename = `habit-tracker-${slug ? `${slug}-` : ""}${new Date()
        .toISOString()
        .slice(0, 10)}.csv`;
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
            <CardTitle>Leaderboard</CardTitle>
            <CardDescription>
              Live totals for this room. Promote co-admins or remove members from here.
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
                <AdminParticipantRow
                  key={entry.telegramId}
                  initData={initData}
                  entry={entry}
                  onChanged={() => void load()}
                  onSelfDemoted={onAdminStatusChanged}
                />
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
          {downloading ? "Preparing CSV…" : "Download CSV"}
        </Button>

        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Trophy className="h-3.5 w-3.5" aria-hidden="true" />
          Ties share the same competition rank.
        </p>
      </CardContent>
    </Card>
  );
}
