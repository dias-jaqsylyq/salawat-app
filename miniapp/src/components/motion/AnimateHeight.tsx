import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, m, useReducedMotion } from "framer-motion";

import { DURATION, EASE_OUT, swapFade } from "@/lib/motion";
import { cn } from "@/lib/utils";

const heightTransition = { duration: DURATION.base, ease: EASE_OUT };

/**
 * Follows its content's height smoothly instead of jumping — e.g. a list row
 * swapping to its edit form. Measures with a ResizeObserver, so it needs no
 * layout-animation feature. Clips only while resizing, so focus rings inside
 * aren't cut off at rest.
 */
export function AnimateHeight({ children, className }: { children: ReactNode; className?: string }) {
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | "auto">("auto");
  const [resizing, setResizing] = useState(false);
  const reduce = useReducedMotion();

  useLayoutEffect(() => {
    const node = inner.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setHeight(node.offsetHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <m.div
      className={cn(resizing && "overflow-hidden", className)}
      initial={false}
      animate={{ height }}
      transition={reduce ? { duration: 0 } : heightTransition}
      onAnimationStart={() => setResizing(true)}
      onAnimationComplete={() => setResizing(false)}
    >
      <div ref={inner}>{children}</div>
    </m.div>
  );
}

/**
 * One of several contents (by `swapKey`) inside an AnimateHeight: the old one
 * fades out, then the new one fades in while the height follows.
 */
export function HeightSwap({ swapKey, children, className }: { swapKey: string; children: ReactNode; className?: string }) {
  return (
    <AnimateHeight className={className}>
      <AnimatePresence mode="wait" initial={false}>
        <m.div key={swapKey} variants={swapFade} initial="initial" animate="animate" exit="exit">
          {children}
        </m.div>
      </AnimatePresence>
    </AnimateHeight>
  );
}

/** Content that grows open from nothing and shrinks away, e.g. an inline form. */
export function Collapse({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  const reduce = useReducedMotion();
  const transition = reduce ? { duration: 0 } : heightTransition;
  return (
    <AnimatePresence initial={false}>
      {open && (
        <m.div
          className={className}
          // Clipped while it grows or shrinks; let out once open, so focus
          // rings and shadows inside aren't cut off.
          initial={{ height: 0, opacity: 0, overflow: "hidden" }}
          animate={{ height: "auto", opacity: 1, transition, transitionEnd: { overflow: "visible" } }}
          exit={{ height: 0, opacity: 0, overflow: "hidden", transition }}
        >
          {children}
        </m.div>
      )}
    </AnimatePresence>
  );
}
