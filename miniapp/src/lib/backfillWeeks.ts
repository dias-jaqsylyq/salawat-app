/**
 * Groups the backfill window's days (BACKFILL PRD: the room's current week
 * plus the two before it) into the three week-sections the day picker shows,
 * each under its own header — "This week" / "Last week" / "2 weeks ago" — with
 * no toggle between them: all three are visible at once as one vertical list.
 *
 * Pure date logic, kept out of the component so it can be unit-tested without
 * rendering anything.
 */

export interface BackfillWeekGroup {
  label: string;
  /** Ascending, oldest first — the same order the old single-week strip used. */
  dates: string[];
}

/** Index 0 = the week containing `today`, 1 = the week before it, 2 = two before it. */
const WEEK_LABELS = ["This week", "Last week", "2 weeks ago"];

/** Parse a YYYY-MM-DD key as UTC, so a local read of it can never shift a day. */
function parseUtc(date: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!));
}

function formatUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The Monday (UTC) of the calendar week containing `date`. */
function mondayOf(date: string): string {
  const parsed = parseUtc(date);
  const daysSinceMonday = (parsed.getUTCDay() + 6) % 7; // Mon=0 ... Sun=6
  parsed.setUTCDate(parsed.getUTCDate() - daysSinceMonday);
  return formatUtc(parsed);
}

/**
 * Buckets every day from `minDate` through `today` (inclusive) into the
 * three week-sections, dropping any that fall outside them — a day older
 * than 2 full weeks back should never reach here given the server already
 * clamps `minDate`, but this stays defensive rather than mislabeling one.
 * Empty sections are omitted entirely, so a brand-new window (e.g. a member
 * who just joined) shows only "This week".
 */
export function groupBackfillDays(minDate: string, today: string): BackfillWeekGroup[] {
  const currentMonday = parseUtc(mondayOf(today)).getTime();
  const buckets = new Map<number, string[]>();

  const start = parseUtc(minDate).getTime();
  const end = parseUtc(today).getTime();
  for (let t = start; t <= end; t += 86_400_000) {
    const date = formatUtc(new Date(t));
    const weeksBack = Math.round(
      (currentMonday - parseUtc(mondayOf(date)).getTime()) / (7 * 86_400_000)
    );
    if (weeksBack < 0 || weeksBack >= WEEK_LABELS.length) continue;
    const bucket = buckets.get(weeksBack);
    if (bucket) bucket.push(date);
    else buckets.set(weeksBack, [date]);
  }

  const groups: BackfillWeekGroup[] = [];
  for (let weeksBack = 0; weeksBack < WEEK_LABELS.length; weeksBack++) {
    const dates = buckets.get(weeksBack);
    if (dates && dates.length > 0) groups.push({ label: WEEK_LABELS[weeksBack]!, dates });
  }
  return groups;
}
