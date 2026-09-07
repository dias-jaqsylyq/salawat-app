export type AyahReminder = {
  kind: "ayah";
  arabic: string;
  english: string;
  reference: string;
};

export type HadithReminder = {
  kind: "hadith";
  english: string;
  narrator: string;
  reference: string;
};

export type VirtueReminder = AyahReminder | HadithReminder;

/** Verbatim ayah/hadith reminders — do not paraphrase. */
export const REMINDERS: readonly VirtueReminder[] = [
  {
    kind: "ayah",
    arabic:
      "إِنَّ ٱللَّهَ وَمَلَـٰٓئِكَتَهُۥ يُصَلُّونَ عَلَى ٱلنَّبِىِّ ۚ يَـٰٓأَيُّهَا ٱلَّذِينَ ءَامَنُوا۟ صَلُّوا۟ عَلَيْهِ وَسَلِّمُوا۟ تَسْلِيمًا",
    english:
      "Indeed, Allah confers blessing upon the Prophet, and His angels [ask Him to do so]. O you who have believed, ask [Allah to confer] blessing upon him and ask [Allah to grant him] peace.",
    reference: "Qur'an 33:56",
  },
  {
    kind: "hadith",
    english: "Whoever sends blessings upon me once, Allah will send blessings upon him ten times.",
    narrator: "Abu Huraira",
    reference: "Sahih Muslim 408",
  },
  {
    kind: "hadith",
    english: "The miser is one in whose presence I am mentioned, but he does not send blessings upon me.",
    narrator: "'Ali ibn Abi Talib",
    reference: "Jami' at-Tirmidhi 3546",
  },
  {
    kind: "hadith",
    english:
      "When one of you prays, let him begin by praising and glorifying Allah, then send blessings upon the Prophet, then supplicate for whatever he wishes.",
    narrator: "Fadalah ibn 'Ubayd",
    reference: "Jami' at-Tirmidhi 3477",
  },
] as const;

/** Fisher–Yates shuffle of a copy of REMINDERS (new order per session). */
export function shuffleReminders(): VirtueReminder[] {
  const items = [...REMINDERS];
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = items[i]!;
    items[i] = items[j]!;
    items[j] = tmp;
  }
  return items;
}
