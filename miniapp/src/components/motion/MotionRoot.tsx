import type { ReactNode } from "react";
import { LazyMotion, MotionConfig } from "framer-motion";

const loadFeatures = () => import("./features.ts").then((module) => module.default);

/**
 * The one place framer-motion is configured.
 *
 * - LazyMotion + domAnimation: only the animation features this app uses
 *   (no layout/drag), so components must use `m.*`, not `motion.*`; `strict`
 *   makes a stray `motion.*` throw in development. The features load as their
 *   own chunk after first paint — until then elements simply render in place.
 * - reducedMotion="user": under prefers-reduced-motion every transform
 *   animation (slide, scale) jumps straight to its end; opacity still fades.
 *   Things that animate other properties (height, counters) check
 *   useReducedMotion() themselves.
 */
export function MotionRoot({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={loadFeatures} strict>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}
