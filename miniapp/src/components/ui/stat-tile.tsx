import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { AnimatedNumber } from "@/components/motion/AnimatedNumber";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const TONE = {
  neutral: "text-foreground",
  brand: "text-primary",
  accent: "text-accent",
} as const;

interface StatTileProps {
  label: string;
  /** A number counts to its new value (see AnimatedNumber); anything else shows as is. */
  value: ReactNode;
  unit?: string;
  hint?: ReactNode;
  icon?: LucideIcon;
  tone?: keyof typeof TONE;
  /** Shows a skeleton in place of the value. */
  loading?: boolean;
  className?: string;
}

/** One headline number with its label, e.g. "Today · 120". */
function StatTile({ label, value, unit, hint, icon, tone = "neutral", loading = false, className }: StatTileProps) {
  return (
    <div className={cn("rounded-lg bg-surface-2 px-4 py-3", className)}>
      <p className="flex items-center gap-1 text-caption font-semibold uppercase tracking-wide text-muted-foreground">
        {icon && <Icon icon={icon} className={TONE[tone]} />}
        {label}
      </p>
      {loading ? (
        <Skeleton shape="block" className="mt-1 h-8 w-20" />
      ) : (
        <p className={cn("mt-1 text-title numeric font-bold", TONE[tone])}>
          {typeof value === "number" ? <AnimatedNumber value={value} /> : value}
          {unit && <span className="ml-1 text-footnote font-semibold text-muted-foreground">{unit}</span>}
        </p>
      )}
      {hint && <p className="mt-1 text-footnote text-muted-foreground">{hint}</p>}
    </div>
  );
}

export { StatTile };
