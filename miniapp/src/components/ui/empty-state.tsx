import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: { label: string; onClick: () => void };
  /** Smaller variant for an empty section inside a card. */
  compact?: boolean;
  className?: string;
}

/** What a screen or section shows when there's nothing in it yet. */
function EmptyState({ icon, title, description, action, compact = false, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center text-center",
        compact ? "gap-2 px-4 py-6" : "gap-3 px-6 py-12",
        className
      )}
    >
      <div
        className={cn(
          "flex items-center justify-center rounded-full bg-surface-3 text-muted-foreground",
          compact ? "size-10" : "size-12"
        )}
      >
        <Icon icon={icon} size={compact ? "md" : "lg"} />
      </div>
      <h2 className={cn("text-foreground", compact ? "text-body font-semibold" : "text-headline")}>{title}</h2>
      {description && <p className="max-w-xs text-footnote text-muted-foreground">{description}</p>}
      {action && (
        <Button
          type="button"
          variant={compact ? "outline" : "default"}
          size={compact ? "sm" : "default"}
          className="mt-1"
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      )}
    </div>
  );
}

export { EmptyState };
