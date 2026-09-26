import { useRef, type KeyboardEvent, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { Icon } from "@/components/ui/icon";
import { hapticSelection } from "@/lib/haptics";
import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: LucideIcon;
  disabled?: boolean;
}

interface SegmentedControlProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  "aria-label": string;
  /** sm: 36px tall, footnote text; md: 44px, body text. With icons, each segment
   *  stacks icon over label (48px, footnote) so four segments fit a phone. */
  size?: "sm" | "md";
  disabled?: boolean;
  className?: string;
}

/**
 * Equal-width segments on an inset track, with a raised thumb that slides to the
 * selected one. A radio group for assistive tech: arrow keys move and select.
 */
function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  "aria-label": ariaLabel,
  size = "md",
  disabled = false,
  className,
}: SegmentedControlProps<T>) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = options.findIndex((option) => option.value === value);
  const isEnabled = (i: number) => !disabled && !options[i].disabled;
  const stacked = options.some((option) => option.icon);

  function select(i: number) {
    if (!isEnabled(i) || i === selected) return;
    hapticSelection();
    onChange(options[i].value);
  }

  function handleKeyDown(event: KeyboardEvent, from: number) {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    let target: number | undefined;
    if (step) {
      for (let n = 1; n <= options.length; n++) {
        const i = (from + step * n + options.length) % options.length;
        if (isEnabled(i)) {
          target = i;
          break;
        }
      }
    } else if (event.key === "Home" || event.key === "End") {
      const order = options.map((_, i) => i);
      target = (event.key === "Home" ? order : order.reverse()).find(isEnabled);
    }
    if (target === undefined) return;
    event.preventDefault();
    select(target);
    buttons.current[target]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      className={cn("relative grid rounded-xl bg-surface-2 p-1", className)}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {selected >= 0 && (
        <div
          aria-hidden="true"
          className="absolute inset-y-1 left-1 rounded-lg bg-surface-1 shadow-sm transition-transform duration-200 ease-out motion-reduce:transition-none dark:bg-surface-3"
          style={{
            width: `calc((100% - 0.5rem) / ${options.length})`,
            transform: `translateX(${selected * 100}%)`,
          }}
        />
      )}
      {options.map((option, i) => {
        const checked = i === selected;
        return (
          <button
            key={option.value}
            ref={(node) => {
              buttons.current[i] = node;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={i === Math.max(selected, 0) ? 0 : -1}
            disabled={!isEnabled(i)}
            onClick={() => select(i)}
            onKeyDown={(event) => handleKeyDown(event, i)}
            className={cn(
              "relative flex min-w-0 items-center justify-center rounded-lg font-semibold transition duration-100 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
              stacked
                ? "min-h-12 flex-col gap-1 px-1 text-footnote"
                : cn("gap-2 px-3", size === "sm" ? "min-h-9 text-footnote" : "min-h-11 text-body"),
              checked ? "text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {option.icon && <Icon icon={option.icon} />}
            <span className="max-w-full truncate">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export { SegmentedControl };
