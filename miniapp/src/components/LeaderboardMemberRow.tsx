import { useState } from "react";
import { ShieldCheck, UserMinus } from "lucide-react";
import { kickParticipant, promoteParticipant } from "../api/client.ts";
import { messageForApiError } from "../api/errors.ts";
import type { LeaderboardMember } from "../api/types.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  initData: string;
  entry: LeaderboardMember;
  /** Another row shares this rank — competition ranking makes ties visible. */
  tied: boolean;
  /** The viewer is an admin of this room, so the row may carry admin detail. */
  isAdmin: boolean;
  /** Edit mode is on: show the actions as well as the detail. */
  editing: boolean;
  /** Refetch the board after promote/kick changed it. */
  onChanged: () => void;
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

/**
 * One member of the room, as everyone sees them — this is the only members list
 * there is, for admins and participants alike.
 *
 * An admin additionally sees who holds co-admin and each member's real name,
 * and in edit mode gets the two governance actions (PRD §3, §3a). Demote is not
 * offered here: the endpoint and `demoteRoomAdmin` still exist, but taking
 * co-admin back is not something this screen does.
 */
export default function LeaderboardMemberRow({
  initData,
  entry,
  tied,
  isAdmin,
  editing,
  onChanged,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>, fallback: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(messageForApiError(err, fallback));
    } finally {
      setBusy(false);
    }
  }

  function handlePromote() {
    if (entry.telegramId === undefined) return;
    // No confirmation: promoting is additive and immediately reversible through
    // the API, unlike a kick.
    void run(
      () => promoteParticipant(initData, entry.telegramId!),
      "Couldn't promote that participant."
    );
  }

  function handleKick() {
    if (entry.telegramId === undefined) return;
    const confirmed = window.confirm(
      `Kick ${entry.nickname} from this room?\n\nEverything they logged here is deleted and ` +
        "they're told by the bot. They can rejoin later with the room password, starting fresh."
    );
    if (!confirmed) return;
    void run(
      () => kickParticipant(initData, entry.telegramId!),
      "Couldn't kick that participant."
    );
  }

  const realName = entry.realName?.trim() ?? "";

  return (
    <div
      className={cn(
        "px-4 py-3",
        rankRowTint(entry.rank),
        entry.isYou && "border-l-2 border-primary",
        entry.isYou && entry.rank > 3 && "bg-primary/5"
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-3 text-sm font-medium text-foreground">
          <Badge variant={rankBadgeVariant(entry.rank)} className="w-7 shrink-0 justify-center">
            {entry.rank}
          </Badge>
          <span className="flex min-w-0 flex-col">
            <span className="flex items-center gap-1.5">
              <span className="truncate">
                {entry.nickname}
                {entry.isYou ? " (You)" : ""}
              </span>
              {entry.isRoomAdmin && (
                <Badge variant="outline" className="shrink-0 gap-1">
                  <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                  Admin
                </Badge>
              )}
            </span>
            {isAdmin && realName && (
              <span className="truncate text-xs font-normal text-muted-foreground">{realName}</span>
            )}
            {tied && <span className="text-xs font-normal text-muted-foreground">tied</span>}
          </span>
        </span>
        <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
          {entry.totalPoints.toLocaleString()}
        </span>
      </div>

      {editing && entry.telegramId !== undefined && (
        <div className={cn("mt-2 flex flex-wrap gap-2", busy && "opacity-60")}>
          {!entry.isRoomAdmin && (
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={handlePromote}>
              <ShieldCheck className="h-3.5 w-3.5" />
              Make co-admin
            </Button>
          )}
          {/* Kicking yourself is refused by the server — leaving is Settings → Leave room. */}
          {!entry.isYou && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              disabled={busy}
              onClick={handleKick}
            >
              <UserMinus className="h-3.5 w-3.5" />
              Kick
            </Button>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
