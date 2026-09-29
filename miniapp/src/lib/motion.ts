import type { Transition, Variants } from "framer-motion";

/**
 * The app's motion vocabulary, in one place. Components pick a token here rather
 * than inventing their own timings, so every transition shares the same feel.
 *
 * Reduced motion is handled one level up: <MotionRoot> sets
 * `reducedMotion="user"`, which drops transform animations (slides, scale)
 * and keeps opacity — so these variants need no reduced-motion twins.
 */

/** Seconds, because that's what framer-motion takes. */
export const DURATION = {
  /** Small state changes: a fade, an item appearing. */
  fast: 0.15,
  /** Tab crossfade, height changes, month slide. */
  base: 0.2,
  /** Number count-up. */
  count: 0.6,
} as const;

export const EASE_OUT = [0.22, 1, 0.36, 1] as const;

export const SPRING = {
  /** A pushed sub-screen: settles in ~280ms, no overshoot. */
  push: { type: "spring", stiffness: 380, damping: 40, mass: 1 },
  /** A calendar page following the finger, then settling. */
  page: { type: "spring", stiffness: 420, damping: 42 },
} as const satisfies Record<string, Transition>;

/** A tab's screen fading in. Enter-only: the outgoing tab unmounts at once. */
export const fadeIn: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.18, ease: EASE_OUT } },
};

/** A sub-screen (Settings, History) pushed in from the right, popped back out to it. */
export const pushRight: Variants = {
  initial: { x: "100%" },
  animate: { x: 0, transition: SPRING.push },
  exit: { x: "100%", transition: SPRING.push },
};

/**
 * A page of the History calendar sliding in from the side it was paged
 * towards: `direction` 1 = forwards (next month enters from the right).
 */
export const slideX: Variants = {
  initial: (direction: number) => ({ x: `${direction * 30}%`, opacity: 0 }),
  animate: { x: 0, opacity: 1, transition: { ...SPRING.page, opacity: { duration: DURATION.base } } },
  exit: (direction: number) => ({
    x: `${direction * -30}%`,
    opacity: 0,
    transition: { ...SPRING.page, opacity: { duration: DURATION.fast } },
  }),
};

/** Content swapped inside an <AnimateHeight>: a quick crossfade. */
export const swapFade: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: DURATION.base, ease: EASE_OUT } },
  exit: { opacity: 0, transition: { duration: DURATION.fast / 2 } },
};

/** How far (px) or how fast (px/s) a horizontal swipe must go to turn the page. */
export const SWIPE_DISTANCE = 60;
export const SWIPE_VELOCITY = 400;

/**
 * Which way a finished horizontal swipe pages: 1 = next, -1 = previous, 0 = stay.
 * Swiping left (negative offset) reveals what's to the right, i.e. the next page.
 * A fast flick counts even when short; a slow drag has to go far enough.
 */
export function swipeDirection(offsetX: number, velocityX: number): -1 | 0 | 1 {
  const flung = Math.abs(velocityX) >= SWIPE_VELOCITY;
  const dragged = Math.abs(offsetX) >= SWIPE_DISTANCE;
  if (!flung && !dragged) return 0;
  // A flick decides by its velocity, so a drag that reverses at the end is honored.
  const sign = flung ? Math.sign(velocityX) : Math.sign(offsetX);
  return sign < 0 ? 1 : sign > 0 ? -1 : 0;
}
