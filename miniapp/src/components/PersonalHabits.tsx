import { useEffect, useState, type ComponentProps, type FormEvent } from "react";
import { ChevronRight, ListChecks, Minus, Plus } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { createPersonalHabit, deletePersonalHabit, updatePersonalHabit } from "../api/client.ts";
import { messageForApiError } from "../api/errors.ts";
import type {
  HabitCategory,
  PersonalHabit,
  PersonalHabitLogWindowEntry,
} from "../api/types.ts";
import { CATEGORY_META } from "../lib/habitCategories.ts";
import { confirmAction } from "../telegram/confirm.ts";
import CategoryPicker from "./CategoryPicker.tsx";
import { BinaryHabitRow } from "./HabitLogRow.tsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** Must stay in sync with NAME_MAX_LENGTH in salawat-bot's habitValidation. */
const NAME_MAX_LENGTH = 100;

/** The switch half of a row, supplied by the Log screen, which owns the optimistic state. */
export type ToggleProps = Pick<
  ComponentProps<typeof BinaryHabitRow>,
  "logged" | "error" | "shakeKey" | "onToggle"
>;

interface Props {
  initData: string;
  habits: PersonalHabit[] | null;
  /** This habit's state on the selected day — logged, unlogged, and whether it
   *  can be marked at all (a day before the habit existed). Independent of
   *  "today": a member may be viewing an earlier day of the backfill window. */
  entries: PersonalHabitLogWindowEntry[];
  /** The room's setting: when on, a personal habit needs a category too. */
  categoriesEnabled: boolean;
  /** One row's switch: its (optimistic) state and what a flip does. */
  toggleProps: (habit: PersonalHabit, serverLogged: boolean) => ToggleProps;
  /** A rename or delete landed — refresh the shared progress state. */
  onLogged: () => void;
  /** The list itself changed — refetch it. */
  onListChanged: () => void;
}

function findEntry(
  entries: PersonalHabitLogWindowEntry[],
  personalHabitId: number
): PersonalHabitLogWindowEntry | undefined {
  return entries.find((entry) => entry.personalHabitId === personalHabitId);
}

interface FormValues {
  name: string;
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
  const [category, setCategory] = useState<HabitCategory | null>(initial.category);

  const nameValid = name.trim().length > 0 && name.trim().length <= NAME_MAX_LENGTH;
  const categoryValid = !categoriesEnabled || category !== null;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy || !nameValid || !categoryValid) return;
    onSubmit({ name: name.trim(), category });
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

      {categoriesEnabled && (
        <CategoryPicker
          id={`${idPrefix}-category`}
          value={category}
          disabled={busy}
          onChange={setCategory}
        />
      )}

      {error && (
        <p role="alert" className="text-body text-destructive">
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
 * rows here never show a points line — and never the weekly badge: a personal
 * habit is always a daily yes/no.
 *
 * Deliberately one flat block even in a categories-enabled room: the category
 * is shown as a chip per row rather than splitting this into four sections, so
 * "My Habits" stays the single place a member looks for their own list.
 *
 * Editing works like an iOS list: rows are plain switches until "Edit" in the
 * header turns them into rename (tap the row) and delete (the red ⊖) targets,
 * instead of every row carrying its own pencil and bin all the time. "＋ Add
 * habit" is the card's last row, outside edit mode.
 */
export default function PersonalHabits({
  initData,
  habits,
  entries,
  categoriesEnabled,
  toggleProps,
  onLogged,
  onListChanged,
}: Props) {
  const [editMode, setEditMode] = useState(false);
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

  // Deleting the last habit leaves nothing to edit: drop back to the normal list.
  useEffect(() => {
    if (editMode && habits?.length === 0) setEditMode(false);
  }, [habits, editMode]);

  async function run(action: () => Promise<unknown>, fallback: string, setError: (m: string | null) => void) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      onListChanged();
      // A rename or a delete moves what counts as logged today, so the
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
          ...(categoriesEnabled ? { category: values.category } : {}),
        }),
      "Couldn't save that habit.",
      setFormError
    );
    if (ok) setEditingId(null);
  }

  async function handleDelete(habit: PersonalHabit) {
    const confirmed = await confirmAction({
      title: `Delete "${habit.name}"?`,
      message:
        "Its history goes with it. This only affects your own habits — nothing in the room changes.",
      okText: "Delete",
      destructive: true,
    });
    if (!confirmed) return;
    void run(
      () => deletePersonalHabit(initData, habit.id),
      "Couldn't delete that habit.",
      setRowError
    );
  }

  function toggleEditMode() {
    setEditMode((on) => !on);
    setEditingId(null);
    setAdding(false);
    setFormError(null);
    setRowError(null);
  }

  if (habits === null) return null;

  function categoryBadge(habit: PersonalHabit) {
    if (!categoriesEnabled || !habit.category) return null;
    return (
      <Badge size="sm" icon={CATEGORY_META[habit.category].icon}>
        {habit.category}
      </Badge>
    );
  }

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2 px-1">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="text-headline text-foreground">My Habits</h3>
          <Badge size="sm">Private · no points</Badge>
        </div>
        {habits.length > 0 && (
          <button
            type="button"
            onClick={toggleEditMode}
            aria-pressed={editMode}
            className="-my-2 -mr-2 min-h-11 shrink-0 rounded-lg px-2 text-body font-semibold text-primary transition duration-100 active:scale-[0.97] active:bg-fill-pressed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {editMode ? "Done" : "Edit"}
          </button>
        )}
      </div>

      <Card className="overflow-hidden">
        <CardContent className="divide-y p-0">
          {habits.length === 0 && !adding && (
            <EmptyState
              compact
              icon={ListChecks}
              title="Nothing here yet"
              description="Add a habit only you can see. It never counts for points."
            />
          )}

          {habits.map((habit) => {
            if (editingId === habit.id) {
              return (
                <HabitForm
                  key={habit.id}
                  idPrefix={`personal-habit-${habit.id}`}
                  initial={{ name: habit.name, category: habit.category }}
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
              );
            }

            if (editMode) {
              return (
                <div key={habit.id} className="flex min-h-11 items-center gap-1 pl-2 pr-4">
                  <button
                    type="button"
                    aria-label={`Delete ${habit.name}`}
                    disabled={busy}
                    onClick={() => void handleDelete(habit)}
                    className="flex size-11 shrink-0 items-center justify-center rounded-full transition duration-100 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  >
                    <span className="flex size-6 items-center justify-center rounded-full bg-destructive text-destructive-foreground">
                      <Icon icon={Minus} />
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Edit ${habit.name}`}
                    disabled={busy}
                    onClick={() => {
                      setFormError(null);
                      setEditingId(habit.id);
                    }}
                    className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  >
                    <span className="truncate text-body font-semibold text-foreground">{habit.name}</span>
                    {categoryBadge(habit)}
                    <Icon icon={ChevronRight} className="ml-auto text-muted-foreground" />
                  </button>
                </div>
              );
            }

            const entry = findEntry(entries, habit.id);
            return (
              <BinaryHabitRow
                key={habit.id}
                name={habit.name}
                badge={categoryBadge(habit)}
                disabled={entry !== undefined && !entry.editable}
                {...toggleProps(habit, entry?.logged ?? false)}
              />
            );
          })}

          {adding && (
            <HabitForm
              idPrefix="new-personal-habit"
              initial={{ name: "", category: null }}
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

          {!adding && !editMode && (
            <button
              type="button"
              onClick={() => {
                setFormError(null);
                setAdding(true);
              }}
              className={cn(
                "flex min-h-11 w-full items-center gap-2 px-4 py-3 text-body font-semibold text-primary",
                "transition duration-100 hover:bg-fill active:bg-fill-pressed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              )}
            >
              <Icon icon={Plus} />
              Add habit
            </button>
          )}
        </CardContent>
      </Card>

      {rowError && (
        <p role="alert" className="px-1 text-body text-destructive">
          {rowError}
        </p>
      )}
    </section>
  );
}
