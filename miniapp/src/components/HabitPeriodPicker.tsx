import type { HabitPeriod } from "../api/types.ts";
import { Label } from "@/components/ui/label";
import { SegmentedControl } from "@/components/ui/segmented-control";

interface Props {
  value: HabitPeriod;
  disabled?: boolean;
  onChange: (period: HabitPeriod) => void;
}

const LABELS: Record<HabitPeriod, string> = {
  daily: "Every day",
  weekly: "Once a week",
};

/**
 * Daily / weekly, the two-up toggle the admin habit form uses. It replaces the
 * old quantity/binary picker in the same slot: every habit is done-or-not now,
 * and how often it pays is the only thing left to choose.
 *
 * Create-only by design — the form hides it when editing, because the points
 * already frozen into past logs were scored under whichever rule was in force
 * at the time and cannot be reinterpreted.
 */
export default function HabitPeriodPicker({ value, disabled, onChange }: Props) {
  return (
    <div className="space-y-2">
      <Label>How often</Label>
      <SegmentedControl
        aria-label="How often the habit scores"
        value={value}
        onChange={onChange}
        disabled={disabled}
        options={(["daily", "weekly"] as const).map((option) => ({ value: option, label: LABELS[option] }))}
      />
      <p className="text-footnote text-muted-foreground">
        {value === "weekly"
          ? "Scores once per week, whichever day it's ticked. Ticking more days in the same week doesn't add points."
          : "Scores every day it's ticked."}
      </p>
    </div>
  );
}
