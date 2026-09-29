import { useEffect, useRef, useState } from "react";
import { AnimatePresence, animate, m, useReducedMotion } from "framer-motion";

import { DURATION, EASE_OUT, SPRING } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * The last value each counter showed, for this app session. Screens unmount
 * on every tab switch, so without this Progress would count from zero every
 * time it's shown; with it, coming back after logging counts 120 → 150.
 */
const lastShown = new Map<string, number>();

const format = (n: number) => Math.round(n).toLocaleString();

interface AnimatedNumberProps {
  value: number;
  /** Remembers the last shown value under this key, across remounts. Without
   *  one, the number counts up from zero on mount. */
  id?: string;
  className?: string;
}

/**
 * A number that counts to its new value rather than jumping — Today/All-time,
 * the participant count. Frames are written straight to the DOM, not through
 * React state. Screen readers get only the final value; under reduced motion
 * it simply shows the value.
 */
export function AnimatedNumber({ value, id, className }: AnimatedNumberProps) {
  const reduce = useReducedMotion();
  const node = useRef<HTMLSpanElement>(null);
  const shown = useRef(reduce ? value : ((id !== undefined ? lastShown.get(id) : undefined) ?? 0));
  // The first paint's text; later frames go straight to the node.
  const [initial] = useState(() => format(shown.current));

  useEffect(() => {
    const el = node.current;
    if (!el) return;
    const remember = (n: number) => {
      shown.current = n;
      if (id !== undefined) lastShown.set(id, n);
    };
    if (reduce || shown.current === value) {
      el.textContent = format(value);
      remember(value);
      return;
    }
    const controls = animate(shown.current, value, {
      duration: DURATION.count,
      ease: EASE_OUT,
      onUpdate: (n) => {
        el.textContent = format(n);
        remember(n);
      },
      onComplete: () => remember(value),
    });
    return () => controls.stop();
  }, [value, id, reduce]);

  return (
    <span className={cn("numeric", className)}>
      <span className="sr-only">{format(value)}</span>
      <span ref={node} aria-hidden="true">
        {initial}
      </span>
    </span>
  );
}

const lastRolled = new Map<string, number>();

/**
 * A small integer that rolls — the old value slides out, the new one in from
 * below when it grows, from above when it drops. For streak counts, where the
 * change is a step of one and a count-up would be too slow to read.
 */
export function RollingNumber({ value, id, className }: { value: number; id: string; className?: string }) {
  // Start from the value this streak last showed, so a change made on another
  // tab still rolls once this mounts.
  const [shown, setShown] = useState(() => lastRolled.get(id) ?? value);
  const [direction, setDirection] = useState(1);

  useEffect(() => {
    lastRolled.set(id, value);
    if (value === shown) return;
    setDirection(value > shown ? 1 : -1);
    setShown(value);
  }, [id, value, shown]);

  return (
    <span className={cn("relative inline-flex overflow-hidden numeric", className)}>
      <span className="sr-only">{value}</span>
      <AnimatePresence mode="popLayout" initial={false} custom={direction}>
        <m.span
          key={shown}
          aria-hidden="true"
          custom={direction}
          variants={{
            initial: (d: number) => ({ y: `${d * 100}%`, opacity: 0 }),
            animate: { y: 0, opacity: 1 },
            exit: (d: number) => ({ y: `${d * -100}%`, opacity: 0 }),
          }}
          initial="initial"
          animate="animate"
          exit="exit"
          transition={SPRING.page}
        >
          {shown}
        </m.span>
      </AnimatePresence>
    </span>
  );
}
