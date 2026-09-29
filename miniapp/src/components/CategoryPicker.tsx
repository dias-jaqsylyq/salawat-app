import type { HabitCategory } from "../api/types.ts";
import { CATEGORY_META, CATEGORY_ORDER } from "../lib/habitCategories.ts";
import { Label } from "@/components/ui/label";
import { SegmentedControl } from "@/components/ui/segmented-control";

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
      <SegmentedControl
        id={id}
        aria-label="Habit category"
        value={value}
        onChange={onChange}
        disabled={disabled}
        options={CATEGORY_ORDER.map((category) => ({
          value: category,
          label: category,
          icon: CATEGORY_META[category].icon,
          "aria-label": `${category} — ${CATEGORY_META[category].label}`,
        }))}
      />
    </div>
  );
}

export default CategoryPicker;
