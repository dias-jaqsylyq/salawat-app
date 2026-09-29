export type StreakTier = "unlit" | "lit" | "hot";

/**
 * Seven days is a week of daily practice; four weeks is roughly a month of
 * weekly practice. Different numbers, same "this has become a habit" moment —
 * so the hot tier is reached at a comparable point rather than the same digit.
 */
export function streakTier(streak: number, unit: "days" | "weeks"): StreakTier {
  if (streak <= 0) return "unlit";
  if (streak >= (unit === "weeks" ? 4 : 7)) return "hot";
  return "lit";
}

/**
 * A streak "ignites" only on the move into hot that the viewer actually sees —
 * never on a first sighting (`previous` unknown), which is just its current
 * state, and never while it stays hot.
 */
export function didIgnite(previous: StreakTier | undefined, next: StreakTier): boolean {
  return previous !== undefined && previous !== "hot" && next === "hot";
}

/**
 * The last tier shown per streak, for this app session. Module scope on
 * purpose: the Progress screen unmounts on every tab switch, and a streak that
 * turned hot on the Log screen should ignite when Progress is next shown.
 */
const seenTiers = new Map<string, StreakTier>();

/** Records `next` as seen and says whether this sighting is an ignition. */
export function observeTier(key: string, next: StreakTier): boolean {
  const ignite = didIgnite(seenTiers.get(key), next);
  seenTiers.set(key, next);
  return ignite;
}
