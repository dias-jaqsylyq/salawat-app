/**
 * The admin form's rule for a habit's optional "Extended" level, mirroring
 * salawat-bot adminHabits.ts: a whole number, at least the base points (it is
 * the level's TOTAL, not a bonus), and only on a daily habit.
 */
export function validateExtendedPoints(
  enabled: boolean,
  extendedPoints: string,
  pointsWeight: string,
  maxPoints: number
): string | null {
  if (!enabled) return null;
  const extended = Number(extendedPoints);
  if (extendedPoints.trim() === "" || !Number.isInteger(extended) || extended <= 0 || extended > maxPoints) {
    return `Extended points must be a whole number between 1 and ${maxPoints.toLocaleString()}.`;
  }
  if (extended < Number(pointsWeight)) {
    return "Extended points can't be lower than the basic points.";
  }
  return null;
}
