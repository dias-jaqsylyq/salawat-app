import type { HabitCategory } from "../api/types.ts";
import { CATEGORY_META, CATEGORY_ORDER } from "../lib/habitCategories.ts";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

interface CategoryPickerProps {
  id: string;
  value: HabitCategory | null;
  disabled?: boolean;
  onChange: (category: HabitCategory) => void;
}

/**
 * The fixed four, in the same SQ → IQ → EQ → PQ order the Log screen groups by. */
function CategoryPicker({ id, value, disabled, onChange }: CategoryPickerProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Category</Label>
      <div
        id={id}
        role="tablist"
        aria-label="Habit category"
        className="grid grid-cols-4 gap-1 rounded-lg bg-secondary/60 p-1"
      >
        {CATEGORY_ORDER.map((category) => {
          const { label, icon: Icon } = CATEGORY_META[category];
          const active = value === category;
          return (
            <button
              key={category}
              type="button"
              role="tab"
              aria-selected={active}
              aria-label={`${category} — ${label}`}
              disabled={disabled}
              onClick={() => onChange(category)}
              className={cn(
                "flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-md px-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {category}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default CategoryPicker;
