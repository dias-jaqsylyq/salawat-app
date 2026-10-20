import { Layers } from "lucide-react";
import type { HabitCategory } from "../api/types.ts";
import { CATEGORY_META } from "../lib/habitCategories.ts";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";

/**
 * A category group's heading on the Log and Stats screens. The full name
 * leads; the code is a small badge beside it.
 */
export default function CategoryHeading({ category }: { category: HabitCategory | null }) {
  // Habits an admin hasn't categorised yet still need a home — see
  // groupHabitsByCategory.
  if (category === null) {
    return (
      <div className="flex items-center gap-2 px-1">
        <Icon icon={Layers} size="md" className="text-muted-foreground" />
        <h3 className="text-headline text-foreground">Uncategorized</h3>
      </div>
    );
  }

  const { label, icon: glyph } = CATEGORY_META[category];
  return (
    <div className="flex items-center gap-2 px-1">
      <Icon icon={glyph} size="md" className="text-primary" />
      <h3 className="text-headline text-foreground">{label}</h3>
      <Badge size="sm">{category}</Badge>
    </div>
  );
}
