import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

const SIZES = { sm: 16, md: 20, lg: 24 } as const;

export type IconSize = keyof typeof SIZES;

interface IconProps {
  icon: LucideIcon;
  /** 16 / 20 / 24 px — the only icon sizes in the app. */
  size?: IconSize;
  /** Accessible name; without it the icon is decorative and hidden from screen readers. */
  label?: string;
  /** Solid glyph (fill: currentColor), e.g. a logged day's flame. */
  filled?: boolean;
  className?: string;
}

/** Every lucide icon goes through here so size and stroke stay on the system. */
function Icon({ icon: LucideComponent, size = "sm", label, filled = false, className }: IconProps) {
  return (
    <LucideComponent
      size={SIZES[size]}
      strokeWidth={1.75}
      fill={filled ? "currentColor" : "none"}
      className={cn("shrink-0", className)}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
    />
  );
}

export { Icon };
