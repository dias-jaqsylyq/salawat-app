import * as React from "react";
import { cn } from "@/lib/utils";

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    data-slot="textarea"
    className={cn(
      "flex min-h-28 w-full rounded-md border border-input bg-background px-3 py-2 text-base shadow-xs transition-colors placeholder:text-muted-foreground outline-none",
      "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50",
      "disabled:cursor-not-allowed disabled:opacity-50",
      "md:text-sm",
      className
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";

export { Textarea };
