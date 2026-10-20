/**
 * The admin form's rules for a habit's optional per-completion estimate,
 * mirroring salawat-bot habitValidation.ts / adminHabits.ts: a short unit
 * label, an amount per completion (decimals allowed) that needs the unit, and
 * an Extended amount that needs the Basic one and is at least as large.
 */
export const UNIT_LABEL_MAX_LENGTH = 16;
export const MAX_AMOUNT = 100_000;

const FORBIDDEN_UNIT_CHARS = /[\u0000-\u001f\u007f-\u009f<>]/;

export interface AmountFields {
  unitLabel: string | null;
  amountBasic: number | null;
  amountExtended: number | null;
}

/** "" -> null; "2,5" and "2.5" -> 2.5; anything unparseable -> NaN. */
function parseAmount(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  return Number(trimmed.replace(",", "."));
}

/**
 * Validate the three inputs as typed and return what to send, or the message
 * to show. `withExtended` is whether the habit (as it will be saved) has an
 * Extended level; without one the Extended amount is dropped, not refused.
 */
export function parseAmountFields(
  unit: string,
  basic: string,
  extended: string,
  withExtended: boolean
): { ok: true; fields: AmountFields } | { ok: false; error: string } {
  const unitLabel = unit.trim() === "" ? null : unit.trim();
  if (
    unitLabel !== null &&
    (unitLabel.length > UNIT_LABEL_MAX_LENGTH || FORBIDDEN_UNIT_CHARS.test(unitLabel))
  ) {
    return { ok: false, error: `Unit must be 1–${UNIT_LABEL_MAX_LENGTH} characters, without < or >.` };
  }
  const amountBasic = parseAmount(basic);
  const amountExtended = withExtended ? parseAmount(extended) : null;
  for (const amount of [amountBasic, amountExtended]) {
    if (amount !== null && !(Number.isFinite(amount) && amount > 0 && amount <= MAX_AMOUNT)) {
      return { ok: false, error: `Amount must be a number above 0 and at most ${MAX_AMOUNT.toLocaleString("en-US")}.` };
    }
  }
  if (amountBasic !== null && unitLabel === null) {
    return { ok: false, error: "Enter a unit for the amount." };
  }
  if (amountExtended !== null && amountBasic === null) {
    return { ok: false, error: "Enter the basic amount first." };
  }
  if (amountExtended !== null && amountBasic !== null && amountExtended < amountBasic) {
    return { ok: false, error: "The Extended amount can't be lower than the basic amount." };
  }
  return { ok: true, fields: { unitLabel, amountBasic, amountExtended } };
}

/** An input's starting text for a stored amount. */
export function amountInput(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}
