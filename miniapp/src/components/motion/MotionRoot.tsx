import type { ReactNode } from "react";
import { LazyMotion, MotionConfig, domAnimation } from "framer-motion";

/**
 * The one place framer-motion is configured.
 *
 * - LazyMotion + domAnimation: only the animation features this app uses
 *   (no layout/drag-to-reorder), so components must use `m.*`, not `motion.*`.
 *   `strict` makes a stray `motion.*` throw in development.
 * - reducedMotion="user": under prefers-reduced-motion every transform
 *   animation (slide, scale) jumps straight to its end; opacity still fades.
 *   Things that animate other properties (height, counters) check
 *   useReducedMotion() themselves.
 */
export function MotionRoot({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}
