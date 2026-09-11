import { useCallback, useEffect, useState } from "react";
import { Check, Download, Pencil, RefreshCw, Trophy } from "lucide-react";
import { downloadAdminExport, getAdminLeaderboard, getLeaderboard } from "../api/client.ts";
import { messageForApiError } from "../api/errors.ts";
import type { LeaderboardMember } from "../api/types.ts";
import LeaderboardMemberRow from "../components/LeaderboardMemberRow.tsx";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface Props {
  initData: string;
  /** Admin of the room the viewer is in — unlocks the detail and the actions. */
  isAdmin: boolean;
  /** Names the CSV; taken from the progress payload the app already holds. */
  roomName: string | null;
}

function isTied(entries: LeaderboardMember[], entry: LeaderboardMember): boolean {
  return entries.some((other) => other !== entry && other.rank === entry.rank);
}

/**
 * The room's members, one screen for everybody (PRD §3a). There is no separate
 * admin members list: an admin gets an Edit button on this same board, and
 * inside edit mode each row grows the actions.
 *
 * The rows come from a different endpoint for an admin — GET
 * /api/admin/leaderboard also carries real names, telegram ids and co-admin
 * status — so a participant's copy of this screen never receives the detail it
 * would not be allowed to show.
 */
export default function LeaderboardScreen({ initData, isAdmin, roomName }: Props) {
  const [entries, setEntries] = useState<LeaderboardMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    setEntries(null);
    const fetched = isAdmin ? getAdminLeaderboard(initData) : getLeaderboard(initData);
    fetched
      .then(({ leaderboard }) => {
        setEntries(leaderboard);
      })
      .catch((err) => {
        setError(messageForApiError(err, "Couldn't load the leaderboard."));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [initData, isAdmin]);

  // Remount when the Leaderboard tab is opened → fresh rows.
  useEffect(() => {
    load();
  }, [load]);

  // Losing admin (demoted elsewhere, or left the room) must close edit mode:
  // the reloaded rows no longer carry the ids the actions need.
  useEffect(() => {
    if (!isAdmin) setEditing(false);
  }, [isAdmin]);

  /**
   * The CSV names itself from the room rather than from the server's
   * Content-Disposition, which the anchor's download attribute overrides anyway.
   */
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
    <div className="mx-auto max-w-sm space-y-4 px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
          <Trophy className="h-5 w-5 text-accent" aria-hidden="true" />
          Leaderboard
        </h2>

        {isAdmin && (
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Refresh"
              disabled={loading}
              onClick={load}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={downloading}
              onClick={() => void downloadCsv()}
            >
              <Download className="h-3.5 w-3.5" />
              {downloading ? "…" : "CSV"}
            </Button>
            {/* Save only leaves edit mode: promote and kick already applied as
                they were tapped, so there is nothing batched to submit. */}
            <Button
              type="button"
              variant={editing ? "default" : "outline"}
              size="sm"
              onClick={() => setEditing((wasEditing) => !wasEditing)}
            >
              {editing ? <Check className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
              {editing ? "Save" : "Edit"}
            </Button>
          </div>
        )}
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
              <LeaderboardMemberRow
                key={entry.telegramId ?? `${entry.rank}-${entry.nickname}-${index}`}
                initData={initData}
                entry={entry}
                tied={isTied(entries, entry)}
                isAdmin={isAdmin}
                editing={editing}
                onChanged={load}
              />
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
