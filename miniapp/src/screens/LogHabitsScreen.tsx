import { useCallback, useEffect, useRef, useState } from "react";
import { Layers } from "lucide-react";
import { Icon } from "@/components/ui/icon";
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
  HabitLogWindowEntry,
  HabitLogWindowResponse,
  PersonalHabit,
  PersonalHabitLogWindowResponse,
  RegisteredProgress,
} from "../api/types.ts";
import { hapticMedium } from "../lib/haptics.ts";
import { CATEGORY_META, groupHabitsByCategory } from "../lib/habitCategories.ts";
import { BinaryHabitRow } from "../components/HabitLogRow.tsx";
import WeekDayPicker from "../components/WeekDayPicker.tsx";
import PersonalHabits from "../components/PersonalHabits.tsx";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  initData: string;
  /** The viewer's own private list, null until loaded. */
  personalHabits: PersonalHabit[] | null;
  progress: RegisteredProgress;
  /** Called after a successful log/unlog so the caller can refresh shared progress state. */
  onLogged: () => void;
  /** Called when a personal habit was created, edited or deleted. */
  onPersonalHabitsChanged: () => void;
}

/**
 * One room habit on the selected day: its display fields plus its state, both
 * read from the same day-specific GET /api/habits/log response — daily and
 * weekly alike (BACKFILL PRD). That response, not GET /api/habits, is the
 * list: on a past week it also carries habits deactivated since (locked), and
 * a habit created after the selected day is in it too (also locked, never
 * hidden).
 */
type LogRow = Habit & { entry: HabitLogWindowEntry };

function toLogRows(logWindow: HabitLogWindowResponse): LogRow[] {
  return logWindow.habits.map((entry) => ({
    id: entry.habitId,
    name: entry.name,
    description: entry.description,
    period: entry.period,
    pointsWeight: entry.pointsWeight,
    category: entry.category,
    entry,
  }));
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
  habits: LogRow[];
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
function HabitRows({ habits, onToggle }: HabitRowsProps) {
  return (
    <Card>
      <CardContent className="divide-y p-0">
        {habits.map((habit) => {
          const { entry } = habit;
          return (
            <BinaryHabitRow
              key={habit.id}
              name={habit.name}
              description={habit.description}
              pointsWeight={habit.pointsWeight}
              weekly={habit.period === "weekly"}
              countedThisWeek={entry.countedThisWeek ?? false}
              logged={entry.logged}
              disabled={!entry.editable}
              inactive={!entry.isActive}
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
        <Icon icon={Layers} className="text-muted-foreground" />
        <h3 className="text-footnote font-semibold text-muted-foreground">Uncategorized</h3>
      </div>
    );
  }

  const { label, icon: glyph } = CATEGORY_META[category];
  return (
    <div className="flex items-center gap-2 px-1">
      <Icon icon={glyph} className="text-primary" />
      <h3 className="text-body font-semibold text-foreground">
        {category}
        <span className="ml-2 font-normal text-muted-foreground">{label}</span>
      </h3>
    </div>
  );
}

export default function LogHabitsScreen({
  initData,
  personalHabits,
  progress,
  onLogged,
  onPersonalHabitsChanged,
}: Props) {
  const [logWindow, setLogWindow] = useState<HabitLogWindowResponse | null>(null);
  const [personalLogWindow, setPersonalLogWindow] =
    useState<PersonalHabitLogWindowResponse | null>(null);
  const [windowError, setWindowError] = useState<string | null>(null);
  /** The day being fetched, shown as selected right away; null once it landed. */
  const [pendingDate, setPendingDate] = useState<string | null>(null);
  /** Only the latest request may land — a quick ◄◄ must not end on the middle week. */
  const requestSeq = useRef(0);

  // Both windows describe the same day and share the same backfill bounds
  // (BACKFILL PRD), so they are always loaded together — one date picker
  // drives room habits and the member's own list alike.
  const loadLogWindow = useCallback(
    (date?: string) => {
      const seq = ++requestSeq.current;
      setWindowError(null);
      setPendingDate(date ?? null);
      Promise.all([getHabitLogWindow(initData, date), getPersonalHabitLogWindow(initData, date)])
        .then(([habitsWindow, personalWindow]) => {
          if (seq !== requestSeq.current) return;
          setLogWindow(habitsWindow);
          setPersonalLogWindow(personalWindow);
          setPendingDate(null);
        })
        .catch((err) => {
          if (seq !== requestSeq.current) return;
          setPendingDate(null);
          setWindowError(messageForApiError(err, "Couldn't load that day."));
        });
    },
    [initData]
  );

  // Mounts fresh (and so re-defaults to today, in the current week) every time
  // the Log tab opens — App.tsx only renders this screen while that tab is
  // active.
  useEffect(() => {
    loadLogWindow();
  }, [loadLogWindow]);

  const isToday = logWindow !== null && logWindow.date === logWindow.today;
  const switching = pendingDate !== null && pendingDate !== logWindow?.date;

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
  const rows = logWindow === null ? null : toLogRows(logWindow);
  const groups = categoriesEnabled && rows !== null ? groupHabitsByCategory(rows) : null;

  return (
    <div className="mx-auto max-w-sm space-y-4 px-4 py-6">
      <div>
        <h2 className="text-title text-foreground">Log habits</h2>
        <p className="mt-1 text-footnote text-muted-foreground">
          {logWindow === null ? " " : isToday ? "Today" : formatSelectedDate(logWindow.date)}
        </p>
      </div>

      {logWindow !== null && (
        <WeekDayPicker
          minDate={logWindow.minDate}
          today={logWindow.today}
          selected={pendingDate ?? logWindow.date}
          onSelect={(date) => loadLogWindow(date)}
        />
      )}

      {windowError && (
        <div className="space-y-2">
          <p className="text-body text-destructive">{windowError}</p>
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

      {rows === null && !windowError && <p className="text-footnote text-muted-foreground">Loading…</p>}

      {/* While another day loads, the previous day's rows stay on screen but
          inert and dimmed — never togglable against a day no longer selected. */}
      <div
        className={cn("space-y-4 transition-opacity", switching && "pointer-events-none opacity-50")}
        aria-busy={switching}
      >
        {rows !== null && rows.length === 0 && (
          <p className="text-footnote text-muted-foreground">
            {isToday ? "No active habits yet." : "Nothing to log yet on this day."}
          </p>
        )}

        {rows !== null && rows.length > 0 && groups !== null && (
          <div className="space-y-6">
            {groups.map((group) => (
              <section key={group.category ?? "uncategorized"} className="space-y-2">
                <CategoryHeading category={group.category} />
                <HabitRows habits={group.habits} onToggle={handleToggle} />
              </section>
            ))}
          </div>
        )}

        {rows !== null && rows.length > 0 && groups === null && (
          <HabitRows habits={rows} onToggle={handleToggle} />
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
    </div>
  );
}
