/**
 * Date logic for the Log screen's week-at-a-time day picker (BACKFILL PRD):
 * the backfill window spans the room's current week plus the two before it,
 * shown one Monday-Sunday week at a time under a "This week" / "Last week" /
 * "2 weeks ago" header, with ◄/► to step between weeks.
 *
 * Pure date logic, kept out of the component so it can be unit-tested without
 * rendering anything. Every YYYY-MM-DD key is read as UTC, so a local read of
 * one can never shift a day.
 */

/** Index 0 = the week containing `today`, 1 = the week before it, 2 = two before it. */
const WEEK_LABELS = ["This week", "Last week", "2 weeks ago"];

const DAY_MS = 86_400_000;

/** Parse a YYYY-MM-DD key as UTC, so a local read of it can never shift a day. */
function parseUtc(date: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!));
}

function formatUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return formatUtc(new Date(parseUtc(date).getTime() + days * DAY_MS));
}

/** The Monday (UTC) of the calendar week containing `date`. */
export function mondayOf(date: string): string {
  const parsed = parseUtc(date);
  const daysSinceMonday = (parsed.getUTCDay() + 6) % 7; // Mon=0 ... Sun=6
  return addDays(date, -daysSinceMonday);
}

/** How many whole weeks `date`'s week lies before `today`'s — 0 for this week. */
export function weeksBack(date: string, today: string): number {
  const diff = parseUtc(mondayOf(today)).getTime() - parseUtc(mondayOf(date)).getTime();
  return Math.round(diff / (7 * DAY_MS));
}

/** "This week" / "Last week" / "2 weeks ago"; "N weeks ago" past the window, defensively. */
export function weekLabel(weeks: number): string {
  return WEEK_LABELS[weeks] ?? `${weeks} weeks ago`;
}

export interface PickerDay {
  date: string;
  /** Inside [minDate, today] — a day before the window (or the caller's join) or in the future is inert. */
  selectable: boolean;
}

export interface BackfillWeekView {
  label: string;
  /** Monday first, always all seven — out-of-window days stay, just unselectable. */
  days: PickerDay[];
  /** ◄ — the previous week still has at least one day inside the window. */
  canGoBack: boolean;
  /** ► — false on the current week: there is no future to step into. */
  canGoForward: boolean;
}

/** The single week the picker shows around `selected`, bounded by [minDate, today]. */
export function backfillWeekView(
  minDate: string,
  today: string,
  selected: string
): BackfillWeekView {
  const monday = mondayOf(selected);
  const days: PickerDay[] = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(monday, i);
    days.push({ date, selectable: date >= minDate && date <= today });
  }
  return {
    label: weekLabel(weeksBack(selected, today)),
    days,
    // The previous week's Sunday is the day right before this Monday: if even
    // that is before minDate, the whole previous week is out of the window.
    canGoBack: addDays(monday, -1) >= minDate,
    canGoForward: monday < mondayOf(today),
  };
}

/**
 * The day selected on arriving at the week `weeks` steps away from
 * `selected`'s (negative = back): that week's last day, Sunday — or `today`
 * for the current week, whose Sunday may not have happened yet. Null when the
 * target week has no day inside [minDate, today].
 */
export function dayForWeekStep(
  minDate: string,
  today: string,
  selected: string,
  weeks: number
): string | null {
  const sunday = addDays(mondayOf(selected), weeks * 7 + 6);
  const day = sunday > today ? today : sunday;
  if (day < minDate || mondayOf(day) !== mondayOf(sunday)) return null;
  return day;
}
