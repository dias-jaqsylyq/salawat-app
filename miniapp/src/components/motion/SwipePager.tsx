import { useRef, type PointerEvent, type ReactNode } from "react";
import { AnimatePresence, animate, m, useMotionValue } from "framer-motion";

import { SPRING, slideX, swipeDirection } from "@/lib/motion";
import { AnimateHeight } from "./AnimateHeight.tsx";

interface SwipePagerProps {
  /** Identifies the page on screen; a new key slides the new page in. */
  pageKey: string;
  /** Which way the last page turn went: 1 forward, -1 back, 0 not a turn (just fade). */
  direction: number;
  canPrev: boolean;
  canNext: boolean;
  /** A swipe asked to turn the page (only called when that way is allowed). */
  onPage: (direction: -1 | 1) => void;
  children: ReactNode;
}

/** How far the finger must move before we decide it's a horizontal swipe or a scroll. */
const AXIS_LOCK = 8;
/** How much of the finger's travel the page follows: freely, and at an edge with nowhere to go. */
const FOLLOW = 0.6;
const RESIST = 0.15;

interface Gesture {
  pointerId: number;
  startX: number;
  startY: number;
  axis: "x" | "y" | null;
  lastX: number;
  lastT: number;
  velocity: number;
}

/**
 * Pages that turn with a horizontal swipe, and slide in from the side they
 * were turned towards — however the turn was made (swipe or buttons).
 *
 * Hand-rolled pointer handling rather than framer-motion's `drag`, which would
 * pull in the heavier domMax feature set just for this. `touch-action: pan-y`
 * leaves vertical scrolling to the browser; a gesture only becomes a swipe
 * once it's clearly more horizontal than vertical.
 */
export function SwipePager({ pageKey, direction, canPrev, canNext, onPage, children }: SwipePagerProps) {
  const x = useMotionValue(0);
  const gesture = useRef<Gesture | null>(null);

  function handleDown(event: PointerEvent) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    gesture.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      axis: null,
      lastX: event.clientX,
      lastT: event.timeStamp,
      velocity: 0,
    };
  }

  function handleMove(event: PointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;
    const dx = event.clientX - g.startX;
    const dy = event.clientY - g.startY;
    if (g.axis === null) {
      if (Math.abs(dx) < AXIS_LOCK && Math.abs(dy) < AXIS_LOCK) return;
      g.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (g.axis === "x") event.currentTarget.setPointerCapture(event.pointerId);
    }
    if (g.axis !== "x") return;
    const dt = event.timeStamp - g.lastT;
    if (dt > 0) g.velocity = ((event.clientX - g.lastX) / dt) * 1000;
    g.lastX = event.clientX;
    g.lastT = event.timeStamp;
    // Pulling towards a page that doesn't exist gives way only grudgingly.
    const blocked = (dx > 0 && !canPrev) || (dx < 0 && !canNext);
    x.set(dx * (blocked ? RESIST : FOLLOW));
  }

  function handleEnd(event: PointerEvent) {
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (g.axis !== "x") return;
    // A finger held still before lifting isn't a flick, whatever its last speed.
    const velocity = event.timeStamp - g.lastT > 100 ? 0 : g.velocity;
    const turn = swipeDirection(event.clientX - g.startX, velocity);
    if ((turn === 1 && canNext) || (turn === -1 && canPrev)) onPage(turn);
    void animate(x, 0, SPRING.page);
  }

  return (
    // Clipped sideways only, so the page slides out of view at the edges while
    // the today ring above and below the grid still shows. The -mx/px pair
    // leaves room for rings on the outer columns.
    <AnimateHeight className="-mx-1 overflow-x-clip px-1">
      <m.div
        style={{ x, touchAction: "pan-y" }}
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={handleEnd}
        onPointerCancel={handleEnd}
        className="select-none"
      >
        <AnimatePresence mode="popLayout" initial={false} custom={direction}>
          <m.div key={pageKey} custom={direction} variants={slideX} initial="initial" animate="animate" exit="exit">
            {children}
          </m.div>
        </AnimatePresence>
      </m.div>
    </AnimateHeight>
  );
}
