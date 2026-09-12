import { useEffect, useState, type FormEvent } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import {
  createPersonalHabit,
  deletePersonalHabit,
  deletePersonalHabitLog,
  logPersonalHabit,
  updatePersonalHabit,
} from "../api/client.ts";
import { messageForApiError } from "../api/errors.ts";
import type {
  HabitCategory,
  HabitType,
  PersonalHabit,
  TodayPersonalHabitEntry,
} from "../api/types.ts";
import { hapticMedium } from "../lib/haptics.ts";
import { CATEGORY_META } from "../lib/habitCategories.ts";
import CategoryPicker from "./CategoryPicker.tsx";
import { BinaryHabitRow, QuantityHabitRow } from "./HabitLogRow.tsx";
import HabitTypePicker from "./HabitTypePicker.tsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Must stay in sync with NAME_MAX_LENGTH in salawat-bot's habitValidation. */
const NAME_MAX_LENGTH = 100;

interface Props {
  initData: string;
  habits: PersonalHabit[] | null;
  today: TodayPersonalHabitEntry[];
  /** The room's setting: when on, a personal habit needs a category too. */
  categoriesEnabled: boolean;
  /** A log/unlog landed — refresh the shared progress state. */
  onLogged: () => void;
  /** The list itself changed — refetch it. */
  onListChanged: () => void;
}

function findEntry(
  today: TodayPersonalHabitEntry[],
  personalHabitId: number
): TodayPersonalHabitEntry | undefined {
  return today.find((entry) => entry.personalHabitId === personalHabitId);
}

interface FormValues {
  name: string;
  type: HabitType;
  category: HabitCategory | null;
}

interface HabitFormProps {
  idPrefix: string;
  initial: FormValues;
  categoriesEnabled: boolean;
  submitLabel: string;
  busy: boolean;
  error: string | null;
  onSubmit: (values: FormValues) => void;
  onCancel: () => void;
}

/** One form, used for both "+ Add habit" and editing an existing row. */
function HabitForm({
  idPrefix,
  initial,
  categoriesEnabled,
  submitLabel,
  busy,
  error,
  onSubmit,
  onCancel,
}: HabitFormProps) {
  const [name, setName] = useState(initial.name);
  const [type, setType] = useState<HabitType>(initial.type);
  const [category, setCategory] = useState<HabitCategory | null>(initial.category);

  const nameValid = name.trim().length > 0 && name.trim().length <= NAME_MAX_LENGTH;
  const categoryValid = !categoriesEnabled || category !== null;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy || !nameValid || !categoryValid) return;
    onSubmit({ name: name.trim(), type, category });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 px-4 py-3">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-name`}>Name</Label>
        <Input
          id={`${idPrefix}-name`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={NAME_MAX_LENGTH}
          disabled={busy}
          placeholder="e.g. Read 10 pages"
        />
      </div>

      <HabitTypePicker value={type} disabled={busy} onChange={setType} />

      {categoriesEnabled && (
        <CategoryPicker
          id={`${idPrefix}-category`}
          value={category}
          disabled={busy}
          onChange={setCategory}
        />
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || !nameValid || !categoryValid}>
          {busy ? "Saving…" : submitLabel}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * "My Habits" — the member's own list, under the room's habits on the Log
 * screen.
 *
 * Self-service throughout: unlike a room habit, which only an admin can touch,
 * the owner creates, edits and deletes these themselves. They are private (no
 * admin endpoint reaches them) and carry no points at all, which is why the
 * rows here never show a points line.
 *
 * Deliberately one flat block even in a categories-enabled room: the category
 * is shown as a chip per row rather than splitting this into four sections, so
 * "My Habits" stays the single place a member looks for their own list.
 */
interface PersonalHabitRowProps {
  initData: string;
  habit: PersonalHabit;
  entry: TodayPersonalHabitEntry | undefined;
  onLogged: () => void;
}

/** The same two row shapes the room's habits use, minus the points line. */
function PersonalHabitRow({ initData, habit, entry, onLogged }: PersonalHabitRowProps) {
  if (habit.type === "quantity") {
    return (
      <QuantityHabitRow
        name={habit.name}
        value={entry?.value ?? 0}
        logged={entry?.logged ?? false}
        onSave={async (value) => {
          await logPersonalHabit(initData, habit.id, value);
          hapticMedium();
          onLogged();
        }}
      />
    );
  }
  return (
    <BinaryHabitRow
      name={habit.name}
      logged={entry?.logged ?? false}
      onToggle={async (checked) => {
        if (checked) await logPersonalHabit(initData, habit.id);
        else await deletePersonalHabitLog(initData, habit.id);
        hapticMedium();
        onLogged();
      }}
    />
  );
}

export default function PersonalHabits({
  initData,
  habits,
  today,
  categoriesEnabled,
  onLogged,
  onListChanged,
}: Props) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  // A habit deleted (or the room left) under an open editor has nothing left to
  // edit — close it rather than submitting against an id that is gone.
  useEffect(() => {
    if (editingId !== null && !habits?.some((habit) => habit.id === editingId)) {
      setEditingId(null);
    }
  }, [habits, editingId]);

  async function run(action: () => Promise<unknown>, fallback: string, setError: (m: string | null) => void) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      onListChanged();
      // A type change or a delete moves what counts as logged today, so the
      // shared progress state has to come along.
      onLogged();
      return true;
    } catch (err) {
      setError(messageForApiError(err, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleCreate(values: FormValues) {
    const ok = await run(
      () =>
        createPersonalHabit(initData, {
          name: values.name,
          type: values.type,
          ...(categoriesEnabled ? { category: values.category } : {}),
        }),
      "Couldn't add that habit.",
      setFormError
    );
    if (ok) setAdding(false);
  }

  async function handleEdit(personalHabitId: number, values: FormValues) {
    const ok = await run(
      () =>
        updatePersonalHabit(initData, personalHabitId, {
          name: values.name,
          type: values.type,
          ...(categoriesEnabled ? { category: values.category } : {}),
        }),
      "Couldn't save that habit.",
      setFormError
    );
    if (ok) setEditingId(null);
  }

  function handleDelete(habit: PersonalHabit) {
    const confirmed = window.confirm(
      `Delete "${habit.name}"?\n\nIts history goes with it. This only affects your own ` +
        "habits — nothing in the room changes."
    );
    if (!confirmed) return;
    void run(
      () => deletePersonalHabit(initData, habit.id),
      "Couldn't delete that habit.",
      setRowError
    );
  }

  if (habits === null) return null;

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between px-1">
        <h3 className="text-sm font-semibold text-foreground">My Habits</h3>
        <span className="text-xs text-muted-foreground">Private · no points</span>
      </div>

      <Card>
        <CardContent className="divide-y p-0">
          {habits.length === 0 && !adding && (
            <p className="px-4 py-3 text-sm text-muted-foreground">
              Nothing here yet. Add a habit only you can see.
            </p>
          )}

          {habits.map((habit) =>
            editingId === habit.id ? (
              <HabitForm
                key={habit.id}
                idPrefix={`personal-habit-${habit.id}`}
                initial={{ name: habit.name, type: habit.type, category: habit.category }}
                categoriesEnabled={categoriesEnabled}
                submitLabel="Save"
                busy={busy}
                error={formError}
                onSubmit={(values) => void handleEdit(habit.id, values)}
                onCancel={() => {
                  setEditingId(null);
                  setFormError(null);
                }}
              />
            ) : (
              <div key={habit.id}>
                <PersonalHabitRow
                  initData={initData}
                  habit={habit}
                  entry={findEntry(today, habit.id)}
                  onLogged={onLogged}
                />
                <div className="flex items-center justify-between gap-2 px-4 pb-3">
                  {categoriesEnabled && habit.category ? (
                    <Badge variant="outline" className="gap-1">
                      {(() => {
                        const Icon = CATEGORY_META[habit.category].icon;
                        return <Icon className="h-3 w-3" aria-hidden="true" />;
                      })()}
                      {habit.category}
                    </Badge>
                  ) : (
                    <span />
                  )}
                  <span className="flex gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Edit ${habit.name}`}
                      disabled={busy}
                      onClick={() => {
                        setFormError(null);
                        setEditingId(habit.id);
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete ${habit.name}`}
                      className="text-destructive hover:text-destructive"
                      disabled={busy}
                      onClick={() => handleDelete(habit)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </span>
                </div>
              </div>
            )
          )}

          {adding && (
            <HabitForm
              idPrefix="new-personal-habit"
              initial={{ name: "", type: "binary", category: null }}
              categoriesEnabled={categoriesEnabled}
              submitLabel="Add habit"
              busy={busy}
              error={formError}
              onSubmit={(values) => void handleCreate(values)}
              onCancel={() => {
                setAdding(false);
                setFormError(null);
              }}
            />
          )}
        </CardContent>
      </Card>

      {rowError && (
        <p role="alert" className="px-1 text-sm text-destructive">
          {rowError}
        </p>
      )}

      {!adding && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => {
            setFormError(null);
            setAdding(true);
          }}
        >
          <Plus className="h-3.5 w-3.5" />
          Add habit
        </Button>
      )}
    </section>
  );
}
