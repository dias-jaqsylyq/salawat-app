import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

interface ScreenHeaderProps {
  title: string;
  subtitle?: ReactNode;
  /** Renders a back chevron before the title. */
  onBack?: () => void;
  /** Actions on the right (Edit, CSV, refresh…). */
  trailing?: ReactNode;
  className?: string;
}

/** The title block at the top of every screen. */
function ScreenHeader({ title, subtitle, onBack, trailing, className }: ScreenHeaderProps) {
  return (
    <header className={cn("space-y-1", className)}>
      <div className="flex items-center gap-2">
        {onBack && (
          <Button type="button" variant="ghost" size="icon" className="-ml-2" aria-label="Back" onClick={onBack}>
            <Icon icon={ChevronLeft} size="md" />
          </Button>
        )}
        <h1 className="min-w-0 flex-1 truncate text-title text-foreground">{title}</h1>
        {trailing && <div className="flex shrink-0 items-center gap-2">{trailing}</div>}
      </div>
      {/* pl-8: under the title, past the back button (40px minus its -8px pull) */}
      {subtitle && <p className={cn("text-footnote text-muted-foreground", onBack && "pl-8")}>{subtitle}</p>}
    </header>
  );
}

export { ScreenHeader };
