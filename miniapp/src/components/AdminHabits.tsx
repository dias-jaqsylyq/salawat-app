import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AlertTriangle, Plus, RefreshCw } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { createHabit, getAdminHabits, patchHabit } from "../api/client.ts";
import { messageForApiError } from "../api/errors.ts";
import type { AdminHabit, HabitCategory, HabitPeriod } from "../api/types.ts";
import { validateExtendedPoints } from "../lib/extendedLevel.ts";
import {
  amountInput,
  parseAmountFields,
  UNIT_LABEL_MAX_LENGTH,
  type AmountFields,
} from "../lib/habitAmount.ts";
import { formatNumber } from "../lib/formatAmount.ts";
import { confirmAction } from "../telegram/confirm.ts";
import { CATEGORY_META } from "../lib/habitCategories.ts";
import CategoryPicker from "./CategoryPicker.tsx";
import HabitPeriodPicker from "./HabitPeriodPicker.tsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { HeightSwap } from "./motion/AnimateHeight.tsx";

interface Props {
  initData: string;
  /**
   * The room's category mode. When on, every habit must carry a category — the
   * API rejects a create without one, and rejects a category when off.
   */
  categoriesEnabled: boolean;
}

/** Must stay in sync with salawat-bot adminHabits.ts. */
const NAME_MAX_LENGTH = 100;
const MAX_POINTS_WEIGHT = 1_000_000;

/** Mirrors DESCRIPTION_MAX_LENGTH in salawat-bot. */
const DESCRIPTION_MAX_LENGTH = 200;

/**
 * The optional goal line. Deliberately not validated beyond its length: it is a
 * note to the member, so anything an admin wants to write in it is correct.
 */
function GoalLineField({
  id,
  value,
  disabled,
  onChange,
}: {
  id: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Goal (optional)</Label>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={DESCRIPTION_MAX_LENGTH}
        disabled={disabled}
        placeholder="e.g. min 30 min"
      />
      <p className="text-footnote text-muted-foreground">
        Shown to members next to the habit. It's a note, not a rule — points don't depend on it.
      </p>
    </div>
  );
}

/**
 * The optional second level ("Extended"): a toggle, and while it is on, the
 * points a day logged at that level is worth in total. Daily habits only — the
 * caller doesn't render it for a weekly one.
 */
function ExtendedLevelField({
  id,
  enabled,
  points,
  disabled,
  onEnabledChange,
  onPointsChange,
}: {
  id: string;
  enabled: boolean;
  points: string;
  disabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onPointsChange: (points: string) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <Label htmlFor={`${id}-toggle`}>Extended level</Label>
          <p className="mt-1 text-footnote text-muted-foreground">
            Members pick Basic or Extended when they log. Use the goal line to say what each means.
          </p>
        </div>
        <Switch
          id={`${id}-toggle`}
          checked={enabled}
          disabled={disabled}
          onCheckedChange={onEnabledChange}
        />
      </div>
      {enabled && (
        <div className="space-y-2 animate-fade">
          <Label htmlFor={`${id}-points`}>Extended points (total)</Label>
          <Input
            id={`${id}-points`}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={points}
            onChange={(e) => onPointsChange(e.target.value)}
            disabled={disabled}
            placeholder="e.g. 2"
          />
          <p className="text-footnote text-muted-foreground">
            What an Extended day is worth in all — not added on top. Members can pick it from
            today on; days already logged keep their points.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * The optional estimate behind the Stats tab ("at least 870 min"): a unit and
 * what one completion is worth in it, plus an Extended amount while the habit
 * has that level. Logs only say done / not done, so this is the only place an
 * amount ever comes from.
 */
function AmountField({
  id,
  unit,
  basic,
  extended,
  withExtended,
  disabled,
  onUnitChange,
  onBasicChange,
  onExtendedChange,
}: {
  id: string;
  unit: string;
  basic: string;
  extended: string;
  withExtended: boolean;
  disabled: boolean;
  onUnitChange: (value: string) => void;
  onBasicChange: (value: string) => void;
  onExtendedChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-body font-semibold text-foreground">Amount (optional)</p>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor={`${id}-unit`}>Unit</Label>
          <Input
            id={`${id}-unit`}
            value={unit}
            onChange={(e) => onUnitChange(e.target.value)}
            maxLength={UNIT_LABEL_MAX_LENGTH}
            disabled={disabled}
            placeholder="e.g. min"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${id}-basic`}>{withExtended ? "Per Basic day" : "Per completion"}</Label>
          <Input
            id={`${id}-basic`}
            type="text"
            inputMode="decimal"
            value={basic}
            onChange={(e) => onBasicChange(e.target.value)}
            disabled={disabled}
            placeholder="e.g. 30"
          />
        </div>
      </div>
      {withExtended && (
        <div className="space-y-2 animate-fade">
          <Label htmlFor={`${id}-extended`}>Per Extended day</Label>
          <Input
            id={`${id}-extended`}
            type="text"
            inputMode="decimal"
            value={extended}
            onChange={(e) => onExtendedChange(e.target.value)}
            disabled={disabled}
            placeholder="e.g. 45"
          />
        </div>
      )}
      <p className="text-footnote text-muted-foreground">
        Stats shows the room an estimate like “at least 870 min”. Setting it the first time also
        counts the logs this habit already has; after that, changes apply to new logs only.
      </p>
    </div>
  );
}

/** "30 min each" for the habit list, or null without an amount. */
function amountSummary(habit: AdminHabit): string | null {
  const unit = habit.unitLabel ?? null;
  const basic = habit.amountBasic ?? null;
  if (unit === null || basic === null) return null;
  const extended = habit.amountExtended ?? null;
  return extended !== null
    ? `${formatNumber(basic)} / ${formatNumber(extended)} ${unit}`
    : `${formatNumber(basic)} ${unit} each`;
}

/**
 * Old amounts are frozen into the logs under the old unit and not converted,
 * so relabelling (or dropping) the unit of a habit that already has some asks
 * first. Resolves true when the save may go ahead.
 */
async function confirmUnitChange(habit: AdminHabit, nextUnit: string | null): Promise<boolean> {
  const stored = habit.unitLabel ?? null;
  if (!habit.hasLoggedAmounts || stored === null || nextUnit === stored) return true;
  return confirmAction(
    nextUnit === null
      ? {
          title: "Remove the unit?",
          message: `Stats will stop showing an estimate for this habit. Amounts already logged in “${stored}” are kept, not converted.`,
          okText: "Remove",
        }
      : {
          title: "Rename the unit?",
          message: `Amounts already logged in “${stored}” are not converted — they will show as “${nextUnit}” from now on.`,
          okText: "Rename",
        }
  );
}

function sameAmounts(habit: AdminHabit, fields: AmountFields): boolean {
  return (
    (habit.unitLabel ?? null) === fields.unitLabel &&
    (habit.amountBasic ?? null) === fields.amountBasic &&
    (habit.amountExtended ?? null) === fields.amountExtended
  );
}

function pts(n: number): string {
  return `${n} ${n === 1 ? "pt" : "pts"}`;
}

function validateHabitForm(name: string, pointsWeight: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > NAME_MAX_LENGTH) {
    return `Name must be 1–${NAME_MAX_LENGTH} characters.`;
  }
  const weight = Number(pointsWeight);
  if (!Number.isInteger(weight) || weight <= 0 || weight > MAX_POINTS_WEIGHT) {
    return `Points must be a whole number between 1 and ${MAX_POINTS_WEIGHT.toLocaleString()}.`;
  }
  return null;
}

interface EditRowProps {
  initData: string;
  habit: AdminHabit;
  categoriesEnabled: boolean;
  onSaved: (updated: AdminHabit) => void;
  onCancel: () => void;
}

function EditHabitRow({ initData, habit, categoriesEnabled, onSaved, onCancel }: EditRowProps) {
  const [name, setName] = useState(habit.name);
  const [description, setDescription] = useState(habit.description ?? "");
  const [pointsWeight, setPointsWeight] = useState(String(habit.pointsWeight));
  const [category, setCategory] = useState<HabitCategory | null>(habit.category);
  const storedExtended = habit.extendedPoints ?? null;
  const [extendedEnabled, setExtendedEnabled] = useState(storedExtended !== null);
  const [extendedPoints, setExtendedPoints] = useState(
    storedExtended === null ? "" : String(storedExtended)
  );
  const [unit, setUnit] = useState(habit.unitLabel ?? "");
  const [amountBasic, setAmountBasic] = useState(amountInput(habit.amountBasic));
  const [amountExtended, setAmountExtended] = useState(amountInput(habit.amountExtended));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    const validationError =
      validateHabitForm(name, pointsWeight) ??
      validateExtendedPoints(extendedEnabled, extendedPoints, pointsWeight, MAX_POINTS_WEIGHT);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (categoriesEnabled && category === null) {
      setError("Choose a category for this habit.");
      return;
    }
    const withExtended = habit.period === "daily" && extendedEnabled;
    const amounts = parseAmountFields(unit, amountBasic, amountExtended, withExtended);
    if (!amounts.ok) {
      setError(amounts.error);
      return;
    }
    // Both sent only when they changed, so an unrelated edit never touches them.
    const wantedExtended = extendedEnabled ? Number(extendedPoints) : null;
    const amountsChanged = !sameAmounts(habit, amounts.fields);
    if (amountsChanged && !(await confirmUnitChange(habit, amounts.fields.unitLabel))) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await patchHabit(initData, habit.id, {
        name: name.trim(),
        // Empty means "no goal line" — sent as null so clearing the box
        // actually clears it rather than leaving the old text in place.
        description: description.trim() === "" ? null : description.trim(),
        pointsWeight: Number(pointsWeight),
        // Omitted when the room has categories off — the API rejects a category
        // it isn't using.
        ...(categoriesEnabled && category !== null ? { category } : {}),
        ...(wantedExtended !== storedExtended ? { extendedPoints: wantedExtended } : {}),
        ...(amountsChanged ? amounts.fields : {}),
      });
      onSaved(updated);
    } catch (err) {
      setError(messageForApiError(err, "Couldn't save that habit."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3 px-4 py-3">
      <div className="space-y-2">
        <Label htmlFor={`habit-name-${habit.id}`}>Name</Label>
        <Input
          id={`habit-name-${habit.id}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={NAME_MAX_LENGTH}
          disabled={saving}
        />
      </div>
      <GoalLineField
        id={`habit-description-${habit.id}`}
        value={description}
        disabled={saving}
        onChange={setDescription}
      />
      <div className="space-y-2">
        <Label htmlFor={`habit-weight-${habit.id}`}>Points</Label>
        <Input
          id={`habit-weight-${habit.id}`}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          value={pointsWeight}
          onChange={(e) => setPointsWeight(e.target.value)}
          disabled={saving}
        />
      </div>
      {habit.period === "daily" && (
        <ExtendedLevelField
          id={`habit-extended-${habit.id}`}
          enabled={extendedEnabled}
          points={extendedPoints}
          disabled={saving}
          onEnabledChange={setExtendedEnabled}
          onPointsChange={setExtendedPoints}
        />
      )}
      <AmountField
        id={`habit-amount-${habit.id}`}
        unit={unit}
        basic={amountBasic}
        extended={amountExtended}
        withExtended={habit.period === "daily" && extendedEnabled}
        disabled={saving}
        onUnitChange={setUnit}
        onBasicChange={setAmountBasic}
        onExtendedChange={setAmountExtended}
      />
      {categoriesEnabled && (
        <CategoryPicker
          id={`habit-category-${habit.id}`}
          value={category}
          disabled={saving}
          onChange={setCategory}
        />
      )}
      {/* Shown, not offered: the points already frozen into past logs were
          scored under this cadence, so switching it now would make old weeks
          mean something they never meant. Deactivate and recreate instead. */}
      <p className="text-footnote text-muted-foreground">
        Scores {habit.period === "weekly" ? "once a week" : "every day"}. To change that,
        deactivate this habit and create a new one.
      </p>
      {error && <p className="text-body text-destructive animate-reveal">{error}</p>}
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={() => void handleSave()} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

interface HabitRowProps {
  initData: string;
  habit: AdminHabit;
  categoriesEnabled: boolean;
  onUpdated: (updated: AdminHabit) => void;
}

function HabitRow({ initData, habit, categoriesEnabled, onUpdated }: HabitRowProps) {
  const [editing, setEditing] = useState(false);
  const [togglingActive, setTogglingActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleToggleActive(checked: boolean) {
    if (togglingActive) return;
    setTogglingActive(true);
    setError(null);
    try {
      const updated = await patchHabit(initData, habit.id, { isActive: checked });
      onUpdated(updated);
    } catch (err) {
      setError(messageForApiError(err, "Couldn't update that habit."));
    } finally {
      setTogglingActive(false);
    }
  }

  // The row and its edit form swap with a crossfade while the height follows.
  return (
    <HeightSwap swapKey={editing ? "edit" : "view"}>
      {editing ? (
        <EditHabitRow
          initData={initData}
          habit={habit}
          categoriesEnabled={categoriesEnabled}
          onSaved={(updated) => {
            onUpdated(updated);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div className="space-y-2 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="-mx-1 min-w-0 flex-1 rounded-md px-1 text-left transition duration-100 active:scale-[0.97] active:bg-fill-pressed"
            >
              <span className="flex items-center gap-2">
                <span
                  className={cn(
                    "truncate text-body font-semibold",
                    habit.isActive ? "text-foreground" : "text-quaternary line-through"
                  )}
                >
                  {habit.name}
                </span>
                {habit.period === "weekly" && (
                  <Badge className="shrink-0">
                    weekly
                  </Badge>
                )}
                {categoriesEnabled && habit.category && (
                  <Badge className="shrink-0">
                    {habit.category}
                  </Badge>
                )}
              </span>
              <span className="text-footnote text-muted-foreground">
                {habit.extendedPoints != null
                  ? `${pts(habit.pointsWeight)}, ${pts(habit.extendedPoints)} extended`
                  : `${habit.pointsWeight} pts${habit.period === "weekly" ? " / week" : ""}`}
                {amountSummary(habit) !== null && ` · ${amountSummary(habit)}`}
              </span>
              {habit.description && (
                <span className="mt-1 block truncate text-footnote text-muted-foreground">
                  {habit.description}
                </span>
              )}
              {/* Categories were turned on after this habit was made — the server
                  keeps the old value hidden until the admin re-confirms it (PRD §0). */}
              {categoriesEnabled && !habit.category && (
                <span className="mt-1 flex items-center gap-1 text-footnote font-semibold text-warning">
                  <Icon icon={AlertTriangle} />
                  Tap to set a category
                </span>
              )}
            </button>
            <Switch
              checked={habit.isActive}
              disabled={togglingActive}
              onCheckedChange={(checked) => void handleToggleActive(checked)}
              aria-label={`${habit.isActive ? "Deactivate" : "Activate"} ${habit.name}`}
            />
          </div>
          {error && <p className="text-body text-destructive animate-reveal">{error}</p>}
        </div>
      )}
    </HeightSwap>
  );
}

function CreateHabitForm({
  initData,
  categoriesEnabled,
  onCreated,
}: {
  initData: string;
  categoriesEnabled: boolean;
  onCreated: (habit: AdminHabit) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [period, setPeriod] = useState<HabitPeriod>("daily");
  const [pointsWeight, setPointsWeight] = useState("");
  const [category, setCategory] = useState<HabitCategory | null>(null);
  const [extendedEnabled, setExtendedEnabled] = useState(false);
  const [extendedPoints, setExtendedPoints] = useState("");
  const [unit, setUnit] = useState("");
  const [amountBasic, setAmountBasic] = useState("");
  const [amountExtended, setAmountExtended] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (creating) return;
    const withExtended = period === "daily" && extendedEnabled;
    const validationError =
      validateHabitForm(name, pointsWeight) ??
      validateExtendedPoints(withExtended, extendedPoints, pointsWeight, MAX_POINTS_WEIGHT);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (categoriesEnabled && category === null) {
      setError("Choose a category for this habit.");
      return;
    }
    const amounts = parseAmountFields(unit, amountBasic, amountExtended, withExtended);
    if (!amounts.ok) {
      setError(amounts.error);
      return;
    }
    const { unitLabel, amountBasic: basic, amountExtended: extended } = amounts.fields;
    setCreating(true);
    setError(null);
    try {
      const habit = await createHabit(initData, {
        name: name.trim(),
        description: description.trim() === "" ? null : description.trim(),
        period,
        pointsWeight: Number(pointsWeight),
        ...(categoriesEnabled && category !== null ? { category } : {}),
        ...(withExtended ? { extendedPoints: Number(extendedPoints) } : {}),
        // Omitted when empty, so a create works against a server without amounts.
        ...(unitLabel !== null ? { unitLabel, amountBasic: basic, amountExtended: extended } : {}),
      });
      onCreated(habit);
      setName("");
      setDescription("");
      setPeriod("daily");
      setPointsWeight("");
      setCategory(null);
      setExtendedEnabled(false);
      setExtendedPoints("");
      setUnit("");
      setAmountBasic("");
      setAmountExtended("");
    } catch (err) {
      setError(messageForApiError(err, "Couldn't create that habit."));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon icon={Plus} />
          New habit
        </CardTitle>
      </CardHeader>
      <form onSubmit={(e) => void handleSubmit(e)}>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="new-habit-name">Name</Label>
            <Input
              id="new-habit-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={NAME_MAX_LENGTH}
              disabled={creating}
              placeholder="e.g. Salawat"
            />
          </div>

          <GoalLineField
            id="new-habit-description"
            value={description}
            disabled={creating}
            onChange={setDescription}
          />

          <HabitPeriodPicker value={period} disabled={creating} onChange={setPeriod} />

          <div className="space-y-2">
            <Label htmlFor="new-habit-weight">Points</Label>
            <Input
              id="new-habit-weight"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={pointsWeight}
              onChange={(e) => setPointsWeight(e.target.value)}
              disabled={creating}
              placeholder="e.g. 1"
            />
          </div>

          {/* Weekly habits score once a week; a second level has no place there. */}
          {period === "daily" && (
            <ExtendedLevelField
              id="new-habit-extended"
              enabled={extendedEnabled}
              points={extendedPoints}
              disabled={creating}
              onEnabledChange={setExtendedEnabled}
              onPointsChange={setExtendedPoints}
            />
          )}

          <AmountField
            id="new-habit-amount"
            unit={unit}
            basic={amountBasic}
            extended={amountExtended}
            withExtended={period === "daily" && extendedEnabled}
            disabled={creating}
            onUnitChange={setUnit}
            onBasicChange={setAmountBasic}
            onExtendedChange={setAmountExtended}
          />

          {categoriesEnabled && (
            <CategoryPicker
              id="new-habit-category"
              value={category}
              disabled={creating}
              onChange={setCategory}
            />
          )}

          {error && <p className="text-body text-destructive animate-reveal">{error}</p>}
        </CardContent>
        <CardContent className="pt-0">
          <Button type="submit" className="w-full" disabled={creating}>
            {creating ? "Creating…" : "Create habit"}
          </Button>
        </CardContent>
      </form>
    </Card>
  );
}

export default function AdminHabits({ initData, categoriesEnabled }: Props) {
  const [habits, setHabits] = useState<AdminHabit[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setHabits(await getAdminHabits(initData));
    } catch (err) {
      setError(messageForApiError(err, "Couldn't load habits."));
    } finally {
      setLoading(false);
    }
  }, [initData]);

  // Reload when the room's category mode flips: the rows and the form change
  // shape, and habits created before the flip need their warning re-evaluated.
  useEffect(() => {
    void load();
  }, [load, categoriesEnabled]);

  function updateHabitInList(updated: AdminHabit) {
    setHabits((prev) => prev?.map((h) => (h.id === updated.id ? updated : h)) ?? prev);
  }

  function prependHabit(habit: AdminHabit) {
    setHabits((prev) => (prev ? [habit, ...prev] : [habit]));
  }

  const visibleHabits = habits?.filter((h) => showInactive || h.isActive) ?? null;
  const hasHiddenInactive =
    !showInactive && (habits?.some((h) => !h.isActive) ?? false);

  return (
    <div className="space-y-4">
      <CreateHabitForm
        initData={initData}
        categoriesEnabled={categoriesEnabled}
        onCreated={prependHabit}
      />

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-2">
              <CardTitle>{showInactive ? "All habits" : "Active habits"}</CardTitle>
              <CardDescription>Tap a habit to edit its name or points.</CardDescription>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => void load()}
              disabled={loading}
              aria-label="Refresh habits"
            >
              <Icon icon={RefreshCw} className={cn(loading && "animate-spin")} />
            </Button>
          </div>
          <div className="flex items-center justify-between gap-3 pt-2">
            <Label htmlFor="admin-habits-show-inactive" className="text-footnote font-normal text-muted-foreground">
              Show inactive habits
            </Label>
            <Switch
              id="admin-habits-show-inactive"
              checked={showInactive}
              onCheckedChange={setShowInactive}
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {error && (
            <p role="alert" className="px-4 pb-3 text-body text-destructive animate-reveal">
              {error}
            </p>
          )}
          {loading && !habits && (
            <p className="px-4 pb-4 text-footnote text-muted-foreground">Loading…</p>
          )}
          {visibleHabits && visibleHabits.length === 0 && (
            <p className="px-4 pb-4 text-footnote text-muted-foreground">
              {hasHiddenInactive
                ? 'No active habits — turn on "Show inactive habits" to see them.'
                : "No habits yet."}
            </p>
          )}
          {visibleHabits && visibleHabits.length > 0 && (
            <div className="divide-y">
              {visibleHabits.map((habit) => (
                <HabitRow
                  key={habit.id}
                  initData={initData}
                  habit={habit}
                  categoriesEnabled={categoriesEnabled}
                  onUpdated={updateHabitInList}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
