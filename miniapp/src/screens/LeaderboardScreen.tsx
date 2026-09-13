import { useCallback, useEffect, useState } from "react";
import { Check, Download, Pencil, RefreshCw, Trophy } from "lucide-react";
import { downloadAdminExport, getAdminLeaderboard, getLeaderboard } from "../api/client.ts";
import { messageForApiError } from "../api/errors.ts";
import type { LeaderboardMember, LeaderboardPeriod } from "../api/types.ts";
import LeaderboardMemberRow from "../components/LeaderboardMemberRow.tsx";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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

/** "8–14 Sep" for the week's range, parsed as UTC so it cannot shift a day. */
function weekRange(from: string, to: string): string {
  const parse = (date: string) => {
    const [year, month, day] = date.split("-").map(Number);
    return new Date(Date.UTC(year!, month! - 1, day!));
  };
  const start = parse(from);
  const end = parse(to);
  const full = { timeZone: "UTC", day: "numeric", month: "short" } as const;
  const sameMonth = start.getUTCMonth() === end.getUTCMonth();
  const startLabel = start.toLocaleDateString(
    "en-GB",
    sameMonth ? { timeZone: "UTC", day: "numeric" } : full
  );
  return `${startLabel}–${end.toLocaleDateString("en-GB", full)}`;
}

/**
 * The room's members, one screen for everybody (PRD §3a). There is no separate
 * admin members list: an admin gets an Edit button on this same board, and
 * inside edit mode each row grows the actions.
 *
 * What the two roles see diverges sharply, and on purpose:
 *
 *   member  This week only, resetting every Monday. The full roster in rank
 *           order, so everyone can see where they stand — but points on their
 *           own row alone. There is no all-time board for them at all.
 *   admin   Both periods, via a toggle, with everyone's real points in each,
 *           plus real names, telegram ids and co-admin status.
 *
 * That is enforced by the endpoints rather than by this screen: a participant's
 * copy calls GET /api/leaderboard, which never sends the detail — or the
 * figures — it would not be allowed to show. The toggle below is not a
 * permission check, just a request parameter an admin is allowed to vary.
 */
export default function LeaderboardScreen({ initData, isAdmin, roomName }: Props) {
  const [entries, setEntries] = useState<LeaderboardMember[] | null>(null);
  const [week, setWeek] = useState<{ start: string; end: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [downloading, setDownloading] = useState(false);
  /**
   * Admins only — a member has no choice to make, and their board is weekly
   * whatever this says. Weekly is the default here even for admins so both
   * roles open on the same view and an admin sees what their room sees.
   */
  const [period, setPeriod] = useState<LeaderboardPeriod>("weekly");
  const effectivePeriod: LeaderboardPeriod = isAdmin ? period : "weekly";

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    setEntries(null);
    const fetched = isAdmin
      ? getAdminLeaderboard(initData, period)
      : getLeaderboard(initData);
    fetched
      .then((response) => {
        setEntries(response.leaderboard);
        setWeek({ start: response.weekStart, end: response.weekEnd });
      })
      .catch((err) => {
        setError(messageForApiError(err, "Couldn't load the leaderboard."));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [initData, isAdmin, period]);

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
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
            <Trophy className="h-5 w-5 text-accent" aria-hidden="true" />
            Leaderboard
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {effectivePeriod === "weekly"
              ? week
                ? `This week · ${weekRange(week.start, week.end)}`
                : "This week"
              : "All time"}
          </p>
        </div>

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
            {/* All-time only: the export is for prizes and moderation, which
                are about the whole run — offering it beside a weekly board
                would promise a weekly file that isn't what comes back. */}
            {period === "all-time" && (
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
            )}
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

      {isAdmin && (
        <div
          role="tablist"
          aria-label="Leaderboard period"
          className="grid grid-cols-2 gap-1 rounded-xl bg-secondary/60 p-1"
        >
          {(
            [
              { id: "weekly" as const, label: "This week" },
              { id: "all-time" as const, label: "All time" },
            ]
          ).map((option) => (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={period === option.id}
              onClick={() => setPeriod(option.id)}
              className={cn(
                "min-h-9 rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                period === option.id
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}

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

      {!loading && !error && entries !== null && entries.length > 0 && !isAdmin && (
        <p className="text-xs text-muted-foreground">
          Everyone's place is shown; only your own points are. Resets every Monday.
        </p>
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
