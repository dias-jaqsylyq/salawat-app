import { useState } from "react";
import { messageForApiError } from "../api/errors.ts";
import { Switch } from "@/components/ui/switch";

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
  onToggle: (checked: boolean) => Promise<void>;
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
 */
export function BinaryHabitRow({
  name,
  description,
  pointsWeight,
  weekly,
  countedThisWeek,
  logged,
  onToggle,
}: Props) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleToggle(checked: boolean) {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onToggle(checked);
    } catch (err) {
      setError(messageForApiError(err, "Couldn't update that — please try again."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-1.5 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="text-sm font-medium text-foreground">{name}</p>
            {weekly && (
              <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-secondary-foreground">
                Once a week
              </span>
            )}
          </div>
          {description && (
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          )}
          {pointsWeight !== undefined && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {weekly && countedThisWeek
                ? `${pointsWeight} pts — already counted this week`
                : weekly
                  ? `${pointsWeight} pts once a week`
                  : `${pointsWeight} pts when done`}
            </p>
          )}
        </div>
        <Switch
          checked={logged}
          disabled={saving}
          onCheckedChange={(checked) => void handleToggle(checked)}
        />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
