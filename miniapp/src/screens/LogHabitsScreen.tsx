import { useCallback, useEffect, useState } from "react";
import { Layers } from "lucide-react";
import {
  deleteHabitLog,
  getHabitLogWindow,
  getPersonalHabitLogWindow,
  logHabit,
} from "../api/client.ts";
import { messageForApiError } from "../api/errors.ts";
import type {
  Habit,
  HabitCategory,
  HabitLogWindowResponse,
  PersonalHabit,
  PersonalHabitLogWindowResponse,
  RegisteredProgress,
} from "../api/types.ts";
import { hapticMedium } from "../lib/haptics.ts";
import { CATEGORY_META, groupHabitsByCategory } from "../lib/habitCategories.ts";
import { BinaryHabitRow } from "../components/HabitLogRow.tsx";
import BackfillDayList from "../components/BackfillDayList.tsx";
import PersonalHabits from "../components/PersonalHabits.tsx";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface Props {
  initData: string;
  habits: Habit[] | null;
  /** The viewer's own private list, null until loaded. */
  personalHabits: PersonalHabit[] | null;
  progress: RegisteredProgress;
  /** Called after a successful log/unlog so the caller can refresh shared progress state. */
  onLogged: () => void;
  /** Called when a personal habit was created, edited or deleted. */
  onPersonalHabitsChanged: () => void;
}

interface RowState {
  logged: boolean;
  /** The selected day precedes this habit's own creation — nothing to mark, not a permission question. */
  disabled: boolean;
  countedThisWeek: boolean;
}

/**
 * Resolves each habit's row state for whichever day is selected — daily and
 * weekly alike, both backfillable within the same window now (BACKFILL PRD),
 * both read from the same day-specific GET /api/habits/log response.
 */
function buildRowStates(
  habits: Habit[],
  logWindow: HabitLogWindowResponse
): Map<number, RowState> {
  const entries = new Map(logWindow.habits.map((entry) => [entry.habitId, entry]));
  const states = new Map<number, RowState>();

  for (const habit of habits) {
    const entry = entries.get(habit.id);
    states.set(habit.id, {
      logged: entry?.logged ?? false,
      disabled: entry !== undefined && !entry.editable,
      countedThisWeek: entry?.countedThisWeek ?? false,
    });
  }
  return states;
}

/** "Tue, 9 Sep", parsed as UTC so a local read of the YYYY-MM-DD string can never shift a day. */
function formatSelectedDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  return parsed.toLocaleDateString("en-GB", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

interface HabitRowsProps {
  habits: Habit[];
  rowStates: Map<number, RowState>;
  onToggle: (habit: Habit, checked: boolean) => Promise<void>;
}

/**
 * One card of habit rows — the whole list when categories are off, one group
 * when on.
 *
 * Weekly habits sit among the daily ones in the same categories rather than in
 * a block of their own: from the member's side this is still just "the things
 * my room asks of me", and a separate section would imply a separate ritual.
 * The row's own badge is what tells them the difference.
 */
function HabitRows({ habits, rowStates, onToggle }: HabitRowsProps) {
  return (
    <Card>
      <CardContent className="divide-y p-0">
        {habits.map((habit) => {
          const state = rowStates.get(habit.id);
          return (
            <BinaryHabitRow
              key={habit.id}
              name={habit.name}
              description={habit.description}
              pointsWeight={habit.pointsWeight}
              weekly={habit.period === "weekly"}
              countedThisWeek={state?.countedThisWeek ?? false}
              logged={state?.logged ?? false}
              disabled={state?.disabled ?? false}
              onToggle={(checked) => onToggle(habit, checked)}
            />
          );
        })}
      </CardContent>
    </Card>
  );
}

function CategoryHeading({ category }: { category: HabitCategory | null }) {
  // Habits an admin hasn't categorised yet still need a home — see
  // groupHabitsByCategory.
  if (category === null) {
    return (
      <div className="flex items-center gap-2 px-1">
        <Layers className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-muted-foreground">Uncategorized</h3>
      </div>
    );
  }

  const { label, icon: Icon } = CATEGORY_META[category];
  return (
    <div className="flex items-center gap-2 px-1">
      <Icon className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
      <h3 className="text-sm font-semibold text-foreground">
        {category}
        <span className="ml-1.5 font-normal text-muted-foreground">{label}</span>
      </h3>
    </div>
  );
}

export default function LogHabitsScreen({
  initData,
  habits,
  personalHabits,
  progress,
  onLogged,
  onPersonalHabitsChanged,
}: Props) {
  const [logWindow, setLogWindow] = useState<HabitLogWindowResponse | null>(null);
  const [personalLogWindow, setPersonalLogWindow] =
    useState<PersonalHabitLogWindowResponse | null>(null);
  const [windowError, setWindowError] = useState<string | null>(null);

  // Both windows describe the same day and share the same backfill bounds
  // (BACKFILL PRD), so they are always loaded together — one date picker
  // drives room habits and the member's own list alike.
  const loadLogWindow = useCallback(
    (date?: string) => {
      setWindowError(null);
      Promise.all([getHabitLogWindow(initData, date), getPersonalHabitLogWindow(initData, date)])
        .then(([habitsWindow, personalWindow]) => {
          setLogWindow(habitsWindow);
          setPersonalLogWindow(personalWindow);
        })
        .catch((err) => {
          setWindowError(messageForApiError(err, "Couldn't load that day."));
        });
    },
    [initData]
  );

  // Mounts fresh (and so re-defaults to today) every time the Log tab opens —
  // App.tsx only renders this screen while that tab is active.
  useEffect(() => {
    loadLogWindow();
  }, [loadLogWindow]);

  const isToday = logWindow !== null && logWindow.date === logWindow.today;

  async function handleToggle(habit: Habit, checked: boolean) {
    const date = logWindow?.date;
    if (checked) await logHabit(initData, habit.id, undefined, date);
    else await deleteHabitLog(initData, habit.id, date);
    hapticMedium();
    onLogged();
    loadLogWindow(date);
  }

  // Grouping is the room's choice, not the habit's: a room with categories off
  // shows the same flat list it always did, even though the habits may still
  // carry a stored category (PRD §0).
  const categoriesEnabled = progress.room?.categoriesEnabled ?? false;
  // Daily and weekly habits alike are backfillable within the window now
  // (BACKFILL PRD), so every active habit stays in the list on any day.
  const visibleHabits = habits;
  const groups =
    categoriesEnabled && visibleHabits !== null ? groupHabitsByCategory(visibleHabits) : null;

  const loading = habits === null || logWindow === null;

  return (
    <div className="mx-auto max-w-sm space-y-4 px-4 py-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Log habits</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {logWindow === null ? " " : isToday ? "Today" : formatSelectedDate(logWindow.date)}
        </p>
      </div>

      {logWindow !== null && (
        <BackfillDayList
          minDate={logWindow.minDate}
          today={logWindow.today}
          selected={logWindow.date}
          onSelect={(date) => loadLogWindow(date)}
        />
      )}

      {windowError && (
        <div className="space-y-2">
          <p className="text-sm text-destructive">{windowError}</p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => loadLogWindow(logWindow?.date)}
          >
            Retry
          </Button>
        </div>
      )}

      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {!loading && visibleHabits !== null && visibleHabits.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {isToday ? "No active habits yet." : "Nothing to log yet on this day."}
        </p>
      )}

      {!loading && visibleHabits !== null && visibleHabits.length > 0 && groups !== null && (
        <div className="space-y-5">
          {groups.map((group) => (
            <section key={group.category ?? "uncategorized"} className="space-y-2">
              <CategoryHeading category={group.category} />
              <HabitRows
                habits={group.habits}
                rowStates={buildRowStates(group.habits, logWindow!)}
                onToggle={handleToggle}
              />
            </section>
          ))}
        </div>
      )}

      {!loading && visibleHabits !== null && visibleHabits.length > 0 && groups === null && (
        <HabitRows
          habits={visibleHabits}
          rowStates={buildRowStates(visibleHabits, logWindow!)}
          onToggle={handleToggle}
        />
      )}

      {/* The member's own list, always last and always one block — even in a
          categories-enabled room, where the room's habits above are grouped.
          Backfillable on any day of the same window room habits get
          (BACKFILL PRD), reading and writing the same selected day. */}
      {logWindow !== null && (
        <PersonalHabits
          initData={initData}
          habits={personalHabits}
          entries={personalLogWindow?.habits ?? []}
          date={logWindow.date}
          categoriesEnabled={categoriesEnabled}
          onLogged={onLogged}
          onListChanged={onPersonalHabitsChanged}
        />
      )}
    </div>
  );
}
