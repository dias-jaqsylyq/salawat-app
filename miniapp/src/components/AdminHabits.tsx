import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { createHabit, getAdminHabits, patchHabit } from "../api/client.ts";
import { messageForApiError } from "../api/errors.ts";
import type { AdminHabit, HabitType } from "../api/types.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

interface Props {
  initData: string;
}

/** Must stay in sync with salawat-bot adminHabits.ts. */
const NAME_MAX_LENGTH = 100;
const MAX_POINTS_WEIGHT = 1_000_000;

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
  onSaved: (updated: AdminHabit) => void;
  onCancel: () => void;
}

function EditHabitRow({ initData, habit, onSaved, onCancel }: EditRowProps) {
  const [name, setName] = useState(habit.name);
  const [pointsWeight, setPointsWeight] = useState(String(habit.pointsWeight));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    const validationError = validateHabitForm(name, pointsWeight);
    if (validationError) {
      setError(validationError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await patchHabit(initData, habit.id, {
        name: name.trim(),
        pointsWeight: Number(pointsWeight),
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
  onUpdated: (updated: AdminHabit) => void;
}

function HabitRow({ initData, habit, onUpdated }: HabitRowProps) {
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
            <Badge variant="outline" className="shrink-0">
              {habit.type}
            </Badge>
          </span>
          <span className="text-xs text-muted-foreground">{habit.pointsWeight} pts</span>
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
  onCreated,
}: {
  initData: string;
  onCreated: (habit: AdminHabit) => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<HabitType>("quantity");
  const [pointsWeight, setPointsWeight] = useState("");
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
    setCreating(true);
    setError(null);
    try {
      const habit = await createHabit(initData, {
        name: name.trim(),
        type,
        pointsWeight: Number(pointsWeight),
      });
      onCreated(habit);
      setName("");
      setType("quantity");
      setPointsWeight("");
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
              placeholder="e.g. Salawat count"
            />
          </div>

          <div className="space-y-2">
            <Label>Type</Label>
            <div
              role="tablist"
              aria-label="Habit type"
              className="grid grid-cols-2 gap-1 rounded-lg bg-secondary/60 p-1"
            >
              {(["quantity", "binary"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={type === value}
                  disabled={creating}
                  onClick={() => setType(value)}
                  className={cn(
                    "min-h-10 rounded-md px-3 text-sm font-medium capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    type === value
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {value}
                </button>
              ))}
            </div>
          </div>

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

export default function AdminHabits({ initData }: Props) {
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

  useEffect(() => {
    void load();
  }, [load]);

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
      <CreateHabitForm initData={initData} onCreated={prependHabit} />

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
