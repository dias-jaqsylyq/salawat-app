import { useState } from "react";
import { ShieldCheck, ShieldMinus, UserMinus } from "lucide-react";
import { demoteParticipant, kickParticipant, promoteParticipant } from "../api/client.ts";
import { messageForApiError } from "../api/errors.ts";
import type { AdminLeaderboardEntry } from "../api/types.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  initData: string;
  entry: AdminLeaderboardEntry;
  /** Refetches the leaderboard after promote/demote/kick changes it. */
  onChanged: () => void;
  /** Called when the caller demoted themselves and no longer holds the Admin tab. */
  onSelfDemoted: () => void;
}

/**
 * One leaderboard row with the room's governance actions on it (PRD §3, §3a):
 * promote and demote co-admins, and kick members. There is no separate members
 * list — the leaderboard is it.
 *
 * Co-admins are flat and equal, so demoting the room's original owner is
 * allowed; the server refuses only what would leave the room with no admins at
 * all (`last_admin`), and refuses kicking yourself (`cannot_kick_self` —
 * leaving is Settings → Leave room).
 */
export default function AdminParticipantRow({ initData, entry, onChanged, onSelfDemoted }: Props) {
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
    void run(
      () => promoteParticipant(initData, entry.telegramId),
      "Couldn't promote that participant."
    );
  }

  function handleDemote() {
    const confirmed = window.confirm(
      `Remove co-admin from ${entry.nickname}?\n\nThey keep their habits and points, but lose ` +
        "access to the Admin tab."
    );
    if (!confirmed) return;
    void run(async () => {
      const result = await demoteParticipant(initData, entry.telegramId);
      // Demoting yourself is allowed as long as an admin remains — the Admin tab
      // has to disappear when it succeeds.
      if (entry.isYou && !result.isRoomAdmin) onSelfDemoted();
    }, "Couldn't demote that participant.");
  }

  function handleKick() {
    const confirmed = window.confirm(
      `Kick ${entry.nickname} from this room?\n\nEverything they logged here is deleted and ` +
        "they're told by the bot. They can rejoin later with the room password, starting fresh."
    );
    if (!confirmed) return;
    void run(() => kickParticipant(initData, entry.telegramId), "Couldn't kick that participant.");
  }

  return (
    <div className="space-y-2 px-3 py-2.5">
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary text-sm font-semibold tabular-nums text-secondary-foreground">
          {entry.rank}
        </div>
        <div className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-foreground">{entry.nickname}</span>
            {entry.isRoomAdmin && (
              <Badge variant="outline" className="shrink-0 gap-1">
                <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                Admin
              </Badge>
            )}
            {entry.isYou && <span className="shrink-0 text-xs text-muted-foreground">you</span>}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {entry.realName?.trim() ? entry.realName : "—"}
          </span>
        </div>
        <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
          {entry.totalPoints.toLocaleString()}
        </span>
      </div>

      <div className={cn("flex flex-wrap gap-2", busy && "opacity-60")}>
        {entry.isRoomAdmin ? (
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={handleDemote}>
            <ShieldMinus className="h-3.5 w-3.5" />
            Demote
          </Button>
        ) : (
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

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
