import type { ReactNode } from "react";
import { AnimatePresence, m } from "framer-motion";

import { pushRight } from "@/lib/motion";

interface PushScreenProps {
  /** A key per sub-screen, so switching straight from one to another re-pushes. */
  screenKey: string | null;
  children: ReactNode;
}

/**
 * A sub-screen (Settings, History) laid over the tabs, sliding in from the
 * right and back out on close. It scrolls on its own, so the tab underneath —
 * which stays mounted, and should be made `inert` by the caller — keeps its
 * state and scroll position for the way back.
 *
 * Nothing renders while `screenKey` is null; `children` is the open screen.
 */
export function PushScreen({ screenKey, children }: PushScreenProps) {
  return (
    <AnimatePresence>
      {screenKey !== null && (
        <m.div
          key={screenKey}
          variants={pushRight}
          initial="initial"
          animate="animate"
          exit="exit"
          // No TabBar here, but the last control still has to clear the home
          // indicator on gesture-navigation devices.
          className="fixed inset-0 z-30 overflow-y-auto overscroll-contain bg-background pb-[env(safe-area-inset-bottom)] shadow-lg"
        >
          {children}
        </m.div>
      )}
    </AnimatePresence>
  );
}
