/**
 * Geometry for one Stats habit's mini bar chart: which weeks get a bar, and how
 * tall. Pure, so the rules below are tested without rendering.
 *
 *  - A null week predates the habit and gets no bar at all — not an empty one.
 *  - A 0 week is real and gets a hairline stub, so "nobody did it" reads
 *    differently from "the habit did not exist yet".
 *  - Heights are relative to the tallest week shown, the current one included;
 *    any non-zero week stays visibly taller than a stub.
 */
export interface ChartBar {
  index: number;
  value: number;
  /** 0..1 of the chart's height. */
  height: number;
  isCurrent: boolean;
  isBest: boolean;
}

/** The smallest share of the height a non-zero bar is drawn at. */
const MIN_BAR = 0.08;

export function chartBars(
  weekly: readonly (number | null)[],
  currentWeekIndex: number,
  bestWeekIndex: number | null
): ChartBar[] {
  const max = Math.max(0, ...weekly.map((v) => v ?? 0));
  return weekly.flatMap((value, index) => {
    if (value === null) return [];
    const height = value <= 0 || max === 0 ? 0 : Math.max(MIN_BAR, value / max);
    return [
      {
        index,
        value,
        height,
        isCurrent: index === currentWeekIndex,
        isBest: index === bestWeekIndex,
      },
    ];
  });
}

/** "3 Feb" for a YYYY-MM-DD week start, parsed as UTC so it cannot shift a day. */
export function shortDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!)).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
  });
}

/** What a screen reader hears instead of the bars. */
export function chartSummary(bars: readonly ChartBar[], weekStarts: readonly string[]): string {
  if (bars.length === 0) return "No weeks yet.";
  return bars
    .map((bar) => {
      const label = bar.isCurrent ? "this week so far" : `week of ${shortDate(weekStarts[bar.index] ?? "")}`;
      return `${label}: ${bar.value}${bar.isBest ? " (best)" : ""}`;
    })
    .join(", ");
}
