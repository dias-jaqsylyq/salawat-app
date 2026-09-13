import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AlertTriangle, Plus, RefreshCw } from "lucide-react";
import { createHabit, getAdminHabits, patchHabit } from "../api/client.ts";
import { messageForApiError } from "../api/errors.ts";
import type { AdminHabit, HabitCategory, HabitPeriod } from "../api/types.ts";
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
      <p className="text-xs text-muted-foreground">
        Shown to members next to the habit. It's a note, not a rule — points don't depend on it.
      </p>
    </div>
  );
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    const validationError = validateHabitForm(name, pointsWeight);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (categoriesEnabled && category === null) {
      setError("Choose a category for this habit.");
      return;
    }
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
      <p className="text-xs text-muted-foreground">
        Scores {habit.period === "weekly" ? "once a week" : "every day"}. To change that,
        deactivate this habit and create a new one.
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}
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

  if (editing) {
    return (
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
    );
  }

  return (
    <div className="space-y-1.5 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="min-w-0 flex-1 text-left"
        >
          <span className="flex items-center gap-2">
            <span
              className={cn(
                "truncate text-sm font-medium",
                habit.isActive ? "text-foreground" : "text-muted-foreground line-through"
              )}
            >
              {habit.name}
            </span>
            {habit.period === "weekly" && (
              <Badge variant="outline" className="shrink-0">
                weekly
              </Badge>
            )}
            {categoriesEnabled && habit.category && (
              <Badge variant="outline" className="shrink-0">
                {habit.category}
              </Badge>
            )}
          </span>
          <span className="text-xs text-muted-foreground">
            {habit.pointsWeight} pts{habit.period === "weekly" ? " / week" : ""}
          </span>
          {habit.description && (
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
              {habit.description}
            </span>
          )}
          {/* Categories were turned on after this habit was made — the server
              keeps the old value hidden until the admin re-confirms it (PRD §0). */}
          {categoriesEnabled && !habit.category && (
            <span className="mt-1 flex items-center gap-1 text-xs font-medium text-destructive">
              <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
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
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
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
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (creating) return;
    const validationError = validateHabitForm(name, pointsWeight);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (categoriesEnabled && category === null) {
      setError("Choose a category for this habit.");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const habit = await createHabit(initData, {
        name: name.trim(),
        description: description.trim() === "" ? null : description.trim(),
        period,
        pointsWeight: Number(pointsWeight),
        ...(categoriesEnabled && category !== null ? { category } : {}),
      });
      onCreated(habit);
      setName("");
      setDescription("");
      setPeriod("daily");
      setPointsWeight("");
      setCategory(null);
    } catch (err) {
      setError(messageForApiError(err, "Couldn't create that habit."));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Plus className="h-4 w-4" aria-hidden="true" />
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

          {categoriesEnabled && (
            <CategoryPicker
              id="new-habit-category"
              value={category}
              disabled={creating}
              onChange={setCategory}
            />
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
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
            <div className="space-y-1.5">
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
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            </Button>
          </div>
          <div className="flex items-center justify-between gap-3 pt-2">
            <Label htmlFor="admin-habits-show-inactive" className="text-sm font-normal text-muted-foreground">
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
            <p role="alert" className="px-4 pb-3 text-sm text-destructive">
              {error}
            </p>
          )}
          {loading && !habits && (
            <p className="px-4 pb-4 text-sm text-muted-foreground">Loading…</p>
          )}
          {visibleHabits && visibleHabits.length === 0 && (
            <p className="px-4 pb-4 text-sm text-muted-foreground">
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
