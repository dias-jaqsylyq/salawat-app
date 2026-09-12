import type { HabitType } from "../api/types.ts";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

interface Props {
  value: HabitType;
  disabled?: boolean;
  onChange: (type: HabitType) => void;
}

/** quantity / binary, the same two-up toggle the admin habit form uses. */
export default function HabitTypePicker({ value, disabled, onChange }: Props) {
  return (
    <div className="space-y-2">
      <Label>Type</Label>
      <div
        role="tablist"
        aria-label="Habit type"
        className="grid grid-cols-2 gap-1 rounded-lg bg-secondary/60 p-1"
      >
        {(["quantity", "binary"] as const).map((option) => (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={value === option}
            disabled={disabled}
            onClick={() => onChange(option)}
            className={cn(
              "min-h-10 rounded-md px-3 text-sm font-medium capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              value === option
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}
