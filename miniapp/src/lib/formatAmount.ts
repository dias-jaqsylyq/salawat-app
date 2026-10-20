/**
 * The Stats tab's estimate line. Logs only record done / not done, so the
 * amount is always what the admin said one completion is worth, summed — a
 * floor, never a measurement. Hence "at least".
 *
 * Minutes read better as hours once they pass an hour ("at least 20h 40m");
 * exactly 60 stays "60 min". Every other unit is shown as is. Rounded only
 * here, for display, to at most one decimal.
 */
export function formatAmount(amount: number, unit: string): string {
  if (unit.trim().toLowerCase() === "min" && amount > 60) {
    const totalMinutes = Math.round(amount);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `at least ${hours.toLocaleString("en-US")}h${minutes > 0 ? ` ${minutes}m` : ""}`;
  }
  return `at least ${formatNumber(amount)} ${unit}`;
}

/** At most one decimal, thousands separated: 870, 2.5, 1,234.6. */
export function formatNumber(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 1 });
}
