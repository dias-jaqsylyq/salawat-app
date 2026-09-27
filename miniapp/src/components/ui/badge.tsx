import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import type { LucideIcon } from "lucide-react";

import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-full font-semibold",
  {
    variants: {
      variant: {
        /** Metadata: "weekly", a category, "Admin" */
        neutral: "bg-surface-3 text-muted-foreground",
        /** Brand-tinted: "My Habits", the current room */
        brand: "bg-secondary text-secondary-foreground",
        /** Achieved / special: streaks, the Hijri date */
        accent: "bg-accent-soft text-accent-soft-foreground",
        /** Needs attention, but not an error */
        warning: "bg-warning-soft text-warning",
        gold: "bg-medal-gold text-medal-gold-foreground",
        silver: "bg-medal-silver text-medal-silver-foreground",
        bronze: "bg-medal-bronze text-medal-bronze-foreground",
      },
      size: {
        sm: "h-5 px-2 text-caption",
        md: "h-6 px-2 text-footnote",
      },
    },
    defaultVariants: {
      variant: "neutral",
      size: "md",
    },
  }
);

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  icon?: LucideIcon;
}

function Badge({ className, variant, size, icon, children, ...props }: BadgeProps) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ variant, size }), className)} {...props}>
      {icon && <Icon icon={icon} />}
      {children}
    </span>
  );
}

export { Badge, badgeVariants };
