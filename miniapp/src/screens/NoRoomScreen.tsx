import { DoorOpen, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  nickname: string;
  /** Re-checks GET /api/progress, for after joining a room in the bot. */
  onRefresh: () => void;
}

/**
 * Registered, but in no room — `room: null` on GET /api/progress. Happens after
 * leaving a room (Settings) or being kicked from one; joining another is a bot
 * conversation, since it needs the room's password (MULTI ROOM PRD §2, §3a).
 *
 * Without this screen the app would render an empty day, an empty leaderboard
 * and a zero total, with nothing explaining why.
 */
export default function NoRoomScreen({ nickname, onRefresh }: Props) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-6 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-secondary text-muted-foreground">
        <DoorOpen className="h-6 w-6" aria-hidden="true" />
      </div>
      <h1 className="mt-4 text-lg font-semibold text-foreground">You're not in a room</h1>
      <p className="mt-3 max-w-sm text-sm text-muted-foreground">
        {nickname}, there's nothing to log until you join one. Open the bot chat, send{" "}
        <span className="font-medium text-foreground">/start</span>, and enter the room
        password its admin gave you — or follow their invite link.
      </p>
      <p className="mt-2 max-w-sm text-xs text-muted-foreground">
        Daily reminders stay paused while you're between rooms.
      </p>
      <Button type="button" variant="outline" onClick={onRefresh} className="mt-5">
        <RefreshCw className="h-4 w-4" />
        I've joined — refresh
      </Button>
    </div>
  );
}
