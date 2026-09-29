import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

interface Props {
  name: string;
  /**
   * The admin's free-text goal line ("min 30 min"), or null/omitted. Purely
   * informational: nothing about it is checked, scored or enforced — the member
   * still just ticks the switch. Personal habits never have one.
   */
  description?: string | null;
  /**
   * The room habit's weight, used for the points line. Omitted for a personal
   * habit, which has no points at all — and then no points line is drawn rather
   * than a zero being shown.
   */
  pointsWeight?: number;
  /** Weekly habits pay once a week; the row says so. */
  weekly?: boolean;
  /**
   * Weekly habits only: the week's points are already banked, on this day or an
   * earlier one. Lets the row explain why ticking it again adds nothing,
   * instead of looking broken.
   */
  countedThisWeek?: boolean;
  logged: boolean;
  /**
   * The selected day predates this habit's own creation — not a permission
   * question, just nothing to mark: the habit did not exist yet. The switch is
   * inert and says so, rather than silently doing nothing on tap.
   */
  disabled?: boolean;
  /**
   * A deactivated habit shown on a past day it was still active: read-only
   * history, locked like `disabled` but explained as retired rather than
   * not-yet-created.
   */
  inactive?: boolean;
  /** Shown beside the name, e.g. a personal habit's category. */
  badge?: ReactNode;
  /** Why the last toggle was rolled back; cleared by the next one. */
  error?: string | null;
  /**
   * Bumped on each rollback: a new value replays the switch's shake once.
   * 0 (the default) never shakes.
   */
  shakeKey?: number;
  /**
   * Fired the moment the switch flips. The row never waits on the request:
   * `logged` is already the optimistic value, and the caller rolls it back
   * (with `error` and a new `shakeKey`) if the server refuses.
   */
  onToggle: (checked: boolean) => void;
}

/**
 * One habit on the Log screen: a switch, both ways — tick to log today, untick
 * to unlog it. The same row for daily and weekly habits, and for the member's
 * own private ones.
 *
 * A weekly habit's switch is today's state, exactly like a daily one's: it is
 * *this day* the member is marking, and unticking it clears this day only. What
 * differs is the payout, which happens once a week — so the row carries a
 * "once a week" badge and, once the week is banked, says so. Without that line
 * a second tick later in the week would look like it silently failed to score.
 *
 * Purely presentational: the Log screen owns the optimistic state, so the row
 * stays tappable while a save is still in flight.
 */
export function BinaryHabitRow({
  name,
  description,
  pointsWeight,
  weekly,
  countedThisWeek,
  logged,
  disabled,
  inactive,
  badge,
  error,
  shakeKey = 0,
  onToggle,
}: Props) {
  return (
    <div className="space-y-2 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="text-body font-semibold text-foreground">{name}</p>
            {weekly && (
              <Badge variant="brand" size="sm">
                Once a week
              </Badge>
            )}
            {badge}
          </div>
          {description && (
            <p className="mt-1 text-footnote text-muted-foreground">{description}</p>
          )}
          {pointsWeight !== undefined && (
            <p className="mt-1 text-footnote text-muted-foreground">
              {inactive
                ? "Deactivated — read only"
                : disabled
                  ? "Not tracked yet on this day"
                  : weekly && countedThisWeek
                    ? `${pointsWeight} pts — already counted this week`
                    : weekly
                      ? `${pointsWeight} pts once a week`
                      : `${pointsWeight} pts when done`}
            </p>
          )}
        </div>
        {/* Keyed so each rollback remounts the wrapper and replays the shake. */}
        <span key={shakeKey} className={cn("inline-flex", shakeKey > 0 && "motion-safe:animate-shake")}>
          <Switch
            checked={logged}
            aria-label={name}
            disabled={disabled || inactive}
            onCheckedChange={onToggle}
          />
        </span>
      </div>
      {error && (
        <p role="alert" className="text-footnote text-destructive animate-reveal">
          {error}
        </p>
      )}
    </div>
  );
}
