import { cn } from "@/lib/utils";

interface SkeletonProps {
  /** line: a 16px text bar (default); block: size it with className; circle: an avatar/icon. */
  shape?: "line" | "block" | "circle";
  className?: string;
}

/** Loading placeholder with a shimmer (static under prefers-reduced-motion). */
function Skeleton({ shape = "line", className }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      data-slot="skeleton"
      className={cn(
        "shimmer",
        shape === "line" && "h-4 w-full rounded-md",
        shape === "block" && "rounded-lg",
        shape === "circle" && "size-10 rounded-full",
        className
      )}
    />
  );
}

export { Skeleton };
