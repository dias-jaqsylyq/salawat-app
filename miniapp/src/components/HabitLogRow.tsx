import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { levelAfterTap, type LogLevel } from "@/lib/logState";
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
  /**
   * Room habits: the Extended level's total, or null/omitted for a
   * single-level habit. Drives both the level control and the points hint.
   */
  extendedPoints?: number | null;
  /** Personal habits: offers the Extended level (no points). */
  hasExtended?: boolean;
  /**
   * Extended may be logged on this day. False before the day the admin
   * switched it on: the control then offers only Off / Basic. Defaults to true.
   */
  extendedAvailable?: boolean;
  /** Weekly habits pay once a week; the row says so. */
  weekly?: boolean;
  /**
   * Weekly habits only: the week's points are already banked, on this day or an
   * earlier one. Lets the row explain why ticking it again adds nothing,
   * instead of looking broken.
   */
  countedThisWeek?: boolean;
  /** This day's level — "off" when unlogged. Already the optimistic value. */
  level: LogLevel;
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
   * Fired the moment the switch flips or a level is tapped, with the level
   * wanted ("off" to unlog — including a tap on the level already selected).
   * The row never waits on the request: `level` is already the optimistic
   * value, and the caller rolls it back (with `error` and a new `shakeKey`) if
   * the server refuses.
   */
  onLevelChange: (level: LogLevel) => void;
}

function pts(n: number): string {
  return `${n} ${n === 1 ? "pt" : "pts"}`;
}

/**
 * One habit on the Log screen: a switch, both ways — tick to log today, untick
 * to unlog it. The same row for daily and weekly habits, and for the member's
 * own private ones.
 *
 * A habit with a second level swaps the switch for an Off / Basic / Extended
 * control inside the row. Tapping the selected level clears the day, the same
 * as unticking a switch. Weekly habits never get one.
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
export function HabitLogRow({
  name,
  description,
  pointsWeight,
  extendedPoints,
  hasExtended,
  extendedAvailable = true,
  weekly,
  countedThisWeek,
  level,
  disabled,
  inactive,
  badge,
  error,
  shakeKey = 0,
  onLevelChange,
}: Props) {
  const extended = extendedPoints ?? null;
  const twoLevels = !weekly && (extended !== null || hasExtended === true);
  // A day already logged Extended keeps showing it, even on a day before
  // Extended became available (it was switched off and on again since).
  const levelOptions: SegmentedOption<LogLevel>[] = [
    { value: "off", label: "Off" },
    { value: "basic", label: "Basic" },
    ...(extendedAvailable || level === "extended"
      ? [{ value: "extended" as const, label: "Extended", disabled: !extendedAvailable }]
      : []),
  ];
  const locked = disabled || inactive;
  const pointsLine =
    pointsWeight === undefined
      ? null
      : inactive
        ? "Deactivated — read only"
        : disabled
          ? "Not tracked yet on this day"
          : weekly && countedThisWeek
            ? `${pointsWeight} pts — already counted this week`
            : weekly
              ? `${pointsWeight} pts once a week`
              : twoLevels && extended !== null
                ? `${pts(pointsWeight)}, ${pts(extended)} extended`
                : `${pointsWeight} pts when done`;

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
          {pointsLine !== null && (
            <p className="mt-1 text-footnote text-muted-foreground">{pointsLine}</p>
          )}
        </div>
        {!twoLevels && (
          // Keyed so each rollback remounts the wrapper and replays the shake.
          <span key={shakeKey} className={cn("inline-flex", shakeKey > 0 && "motion-safe:animate-shake")}>
            <Switch
              checked={level !== "off"}
              aria-label={name}
              disabled={locked}
              onCheckedChange={(checked) => onLevelChange(checked ? "basic" : "off")}
            />
          </span>
        )}
      </div>
      {twoLevels && (
        <div key={shakeKey} className={cn(shakeKey > 0 && "motion-safe:animate-shake")}>
          <SegmentedControl
            aria-label={name}
            size="sm"
            value={level}
            options={levelOptions}
            disabled={locked}
            onChange={onLevelChange}
            onReselect={(tapped) => {
              if (tapped !== "off") onLevelChange(levelAfterTap(level, tapped));
            }}
          />
        </div>
      )}
      {error && (
        <p role="alert" className="text-footnote text-destructive animate-reveal">
          {error}
        </p>
      )}
    </div>
  );
}
