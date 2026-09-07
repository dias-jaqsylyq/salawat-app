import { gregorianToHijri } from "@tabby_ai/hijri-converter";

/** Match salawat-bot default TIMEZONE so "today" aligns with Progress. */
const CHALLENGE_TIMEZONE = "Asia/Hong_Kong";

const HIJRI_MONTHS = [
  "Muharram",
  "Safar",
  "Rabi' al-Awwal",
  "Rabi' al-Thani",
  "Jumada al-Ula",
  "Jumada al-Akhirah",
  "Rajab",
  "Sha'ban",
  "Ramadan",
  "Shawwal",
  "Dhu al-Qi'dah",
  "Dhu al-Hijjah",
] as const;

function gregorianPartsInTimezone(now: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);

  return { year: get("year"), month: get("month"), day: get("day") };
}

/** Today's Hijri date in the challenge timezone, e.g. "15 Rabi' al-Thani 1448 AH". */
export function formatHijriDate(now: Date = new Date()): string {
  const g = gregorianPartsInTimezone(now, CHALLENGE_TIMEZONE);
  const h = gregorianToHijri({ year: g.year, month: g.month, day: g.day });
  const monthName = HIJRI_MONTHS[h.month - 1] ?? `Month ${h.month}`;
  return `${h.day} ${monthName} ${h.year} AH`;
}
