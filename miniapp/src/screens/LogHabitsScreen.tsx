import { useCallback, useEffect, useRef, useState } from "react";
import { Layers, ListChecks, Sparkles } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import {
  deleteHabitLog,
  deletePersonalHabitLog,
  getHabitLogWindow,
  getPersonalHabitLogWindow,
  logHabit,
  logPersonalHabit,
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
import { hapticMedium, hapticNotification } from "../lib/haptics.ts";
import { CATEGORY_META, groupHabitsByCategory } from "../lib/habitCategories.ts";
import {
  dayProgress,
  effectiveLogged,
  logKey,
  markedDatesWith,
  toggleFeedback,
  withOverride,
  withoutOverrides,
  type DayProgress,
  type DaySnapshot,
  type LogKind,
  type Overrides,
} from "../lib/logState.ts";
import { BinaryHabitRow } from "../components/HabitLogRow.tsx";
import WeekDayPicker from "../components/WeekDayPicker.tsx";
import PersonalHabits, { type ToggleProps } from "../components/PersonalHabits.tsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Progress } from "@/components/ui/progress";
import { ScreenHeader } from "@/components/ui/screen-header";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface Props {
  initData: string;
  /** The viewer's own private list, null until loaded. */
  personalHabits: PersonalHabit[] | null;
  progress: RegisteredProgress;
  /** Called after a log/unlog is confirmed so the caller can refresh shared progress state. */
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
  toggleProps: (habit: LogRow) => ToggleProps;
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
function HabitRows({ habits, toggleProps }: HabitRowsProps) {
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
              disabled={!entry.editable}
              inactive={!entry.isActive}
              {...toggleProps(habit)}
            />
          );
        })}
      </CardContent>
    </Card>
  );
}

/** The full name leads; the code is a small badge beside it. */
function CategoryHeading({ category }: { category: HabitCategory | null }) {
  // Habits an admin hasn't categorised yet still need a home — see
  // groupHabitsByCategory.
  if (category === null) {
    return (
      <div className="flex items-center gap-2 px-1">
        <Icon icon={Layers} size="md" className="text-muted-foreground" />
        <h3 className="text-headline text-foreground">Uncategorized</h3>
      </div>
    );
  }

  const { label, icon: glyph } = CATEGORY_META[category];
  return (
    <div className="flex items-center gap-2 px-1">
      <Icon icon={glyph} size="md" className="text-primary" />
      <h3 className="text-headline text-foreground">{label}</h3>
      <Badge size="sm">{category}</Badge>
    </div>
  );
}

/**
 * "3 of 5 done" for the room's habits on the selected day, moving with every
 * toggle the moment it happens. A finished day turns gold and swells once.
 */
function DayProgressCard({ progress, isToday }: { progress: DayProgress; isToday: boolean }) {
  const { done, total, complete } = progress;
  return (
    // Keyed on completion so reaching 5/5 remounts the card and plays the pop.
    <Card
      key={complete ? "complete" : "open"}
      className={cn(complete && "border-transparent bg-accent-soft motion-safe:animate-pop")}
    >
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-3">
          {complete ? (
            <p className="flex items-center gap-2 text-body font-semibold text-accent-soft-foreground">
              <Icon icon={Sparkles} size="md" />
              {isToday ? "All done today" : "All done"}
            </p>
          ) : (
            <p className="text-body font-semibold text-foreground">
              {done} of {total} done
            </p>
          )}
          <span
            className={cn(
              "numeric text-footnote font-semibold",
              complete ? "text-accent-soft-foreground" : "text-muted-foreground"
            )}
          >
            {Math.round((done / total) * 100)}%
          </span>
        </div>
        <Progress
          value={(done / total) * 100}
          aria-label={`${done} of ${total} habits done`}
          indicatorClassName={complete ? "bg-accent" : undefined}
        />
      </CardContent>
    </Card>
  );
}

function LoadingRows() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading habits">
      <Skeleton shape="block" className="h-20 w-full rounded-xl" />
      <Card>
        <CardContent className="divide-y p-0">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="flex-1 space-y-2">
                <Skeleton className="w-1/2" />
                <Skeleton className="h-3 w-1/3" />
              </div>
              <Skeleton shape="block" className="h-6 w-11 rounded-full" />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

interface RowFailure {
  message: string;
  shakeKey: number;
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

  /*
   * Optimistic toggles (UI audit A22). A flip lands in `overrides` at once and
   * the request goes out behind it; the switch never waits. Per habit-day at
   * most one request is in flight: flips made meanwhile only move the desired
   * value, and the running request loop sends whatever is desired once it
   * returns — so the server always ends on the member's last tap, never on a
   * reordered earlier one. The ref mirrors the state for that loop.
   */
  const [overrides, setOverrides] = useState<Overrides>({});
  const overridesRef = useRef<Overrides>({});
  const inFlight = useRef(new Set<string>());
  /** Confirmed keys → the requestSeq at confirmation; a later response already includes them. */
  const confirmed = useRef(new Map<string, number>());
  const [failures, setFailures] = useState<Readonly<Record<string, RowFailure>>>({});
  const shakeSeq = useRef(0);

  function applyOverrides(next: Overrides) {
    overridesRef.current = next;
    setOverrides(next);
  }

  // Both windows describe the same day and share the same backfill bounds
  // (BACKFILL PRD), so they are always loaded together — one date picker
  // drives room habits and the member's own list alike. A silent reload (after
  // a toggle) keeps the rows as they are instead of dimming them.
  const loadLogWindow = useCallback(
    (date?: string, silent = false) => {
      const seq = ++requestSeq.current;
      if (!silent) {
        setWindowError(null);
        setPendingDate(date ?? null);
        setFailures({});
      }
      Promise.all([getHabitLogWindow(initData, date), getPersonalHabitLogWindow(initData, date)])
        .then(([habitsWindow, personalWindow]) => {
          if (seq !== requestSeq.current) return;
          setLogWindow(habitsWindow);
          setPersonalLogWindow(personalWindow);
          setPendingDate(null);
          // This response already carries every toggle confirmed before it was
          // sent, so those overrides have nothing left to add.
          const settled = [...confirmed.current]
            .filter(([key, atSeq]) => seq > atSeq && !inFlight.current.has(key))
            .map(([key]) => key);
          if (settled.length > 0) {
            settled.forEach((key) => confirmed.current.delete(key));
            applyOverrides(withoutOverrides(overridesRef.current, settled));
          }
        })
        .catch((err) => {
          if (seq !== requestSeq.current || silent) return;
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

  /** Which day is on screen, for toggle loops that finish after a day switch. */
  const view = useRef({ date: logWindow?.date, switching });
  useEffect(() => {
    view.current = { date: logWindow?.date, switching };
  });

  /** The selected day as it would read under `ov`: marks for the first-mark haptic, progress for 5/5. */
  function snapshot(ov: Overrides): DaySnapshot {
    if (logWindow === null) return { marks: 0, progress: dayProgress([]) };
    const { date } = logWindow;
    const room = logWindow.habits.map((entry) => ({
      ...entry,
      logged: effectiveLogged(ov, logKey(date, "room", entry.habitId), entry.logged),
    }));
    const personal = (personalHabits ?? []).map((habit) => {
      const entry = personalLogWindow?.habits.find((e) => e.personalHabitId === habit.id);
      return effectiveLogged(ov, logKey(date, "personal", habit.id), entry?.logged ?? false);
    });
    return {
      marks: room.filter((r) => r.logged).length + personal.filter(Boolean).length,
      progress: dayProgress(room),
    };
  }

  async function toggle(key: string, date: string, checked: boolean, send: (logged: boolean) => Promise<unknown>) {
    const before = snapshot(overridesRef.current);
    applyOverrides(withOverride(overridesRef.current, key, checked));
    if (toggleFeedback(before, snapshot(overridesRef.current)) === "tap") hapticMedium();
    else hapticNotification("success");

    setFailures(({ [key]: _cleared, ...rest }) => rest);
    confirmed.current.delete(key);
    if (inFlight.current.has(key)) return; // the running loop will send it

    inFlight.current.add(key);
    try {
      let sent: boolean;
      do {
        sent = overridesRef.current[key]!;
        await send(sent);
      } while (overridesRef.current[key] !== sent);
      confirmed.current.set(key, requestSeq.current);
      onLogged();
    } catch (err) {
      applyOverrides(withoutOverrides(overridesRef.current, [key]));
      hapticNotification("error");
      setFailures((prev) => ({
        ...prev,
        [key]: {
          message: messageForApiError(err, "Couldn't save that — please try again."),
          shakeKey: ++shakeSeq.current,
        },
      }));
    } finally {
      inFlight.current.delete(key);
    }
    // Re-sync either way — only while that day is still the one on screen.
    if (view.current.date === date && !view.current.switching) loadLogWindow(date, true);
  }

  function toggleProps(
    kind: LogKind,
    id: number,
    serverLogged: boolean,
    send: (date: string, logged: boolean) => Promise<unknown>
  ): ToggleProps {
    const date = logWindow!.date;
    const key = logKey(date, kind, id);
    const failure = failures[key];
    return {
      logged: effectiveLogged(overrides, key, serverLogged),
      error: failure?.message ?? null,
      shakeKey: failure?.shakeKey ?? 0,
      onToggle: (checked) => void toggle(key, date, checked, (logged) => send(date, logged)),
    };
  }

  const roomToggleProps = (habit: LogRow) =>
    toggleProps("room", habit.id, habit.entry.logged, (date, logged) =>
      logged ? logHabit(initData, habit.id, undefined, date) : deleteHabitLog(initData, habit.id, date)
    );

  const personalToggleProps = (habit: PersonalHabit, serverLogged: boolean) =>
    toggleProps("personal", habit.id, serverLogged, (date, logged) =>
      logged
        ? logPersonalHabit(initData, habit.id, undefined, date)
        : deletePersonalHabitLog(initData, habit.id, date)
    );

  // Grouping is the room's choice, not the habit's: a room with categories off
  // shows the same flat list it always did, even though the habits may still
  // carry a stored category (PRD §0).
  const categoriesEnabled = progress.room?.categoriesEnabled ?? false;
  const rows = logWindow === null ? null : toLogRows(logWindow);
  const groups = categoriesEnabled && rows !== null ? groupHabitsByCategory(rows) : null;
  const day = snapshot(overrides);
  // The viewed day's dot follows the switches live. The server may also count
  // a mark no row here shows (a habit retired earlier this week): when it says
  // "marked" but no visible row is, that hidden mark keeps the dot.
  const hiddenMark =
    logWindow !== null && logWindow.markedDates.includes(logWindow.date) && snapshot({}).marks === 0;
  const markedDates =
    logWindow === null
      ? new Set<string>()
      : markedDatesWith(logWindow.markedDates, logWindow.date, hiddenMark || day.marks > 0);

  return (
    <div className="mx-auto max-w-sm space-y-4 px-4 py-6">
      <ScreenHeader
        title="Log habits"
        subtitle={logWindow === null ? undefined : isToday ? "Today" : formatSelectedDate(logWindow.date)}
      />

      {logWindow !== null && day.progress.total > 0 && (
        <div className={cn("transition-opacity", switching && "opacity-50")}>
          <DayProgressCard progress={day.progress} isToday={isToday} />
        </div>
      )}

      {logWindow !== null && (
        <WeekDayPicker
          minDate={logWindow.minDate}
          today={logWindow.today}
          selected={pendingDate ?? logWindow.date}
          markedDates={markedDates}
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

      {rows === null && !windowError && <LoadingRows />}

      {/* While another day loads, the previous day's rows stay on screen but
          inert and dimmed — never togglable against a day no longer selected. */}
      <div
        className={cn("space-y-6 transition-opacity", switching && "pointer-events-none opacity-50")}
        aria-busy={switching}
      >
        {rows !== null && rows.length === 0 && (
          <Card>
            <EmptyState
              compact
              icon={ListChecks}
              title={isToday ? "No active habits yet" : "Nothing to log on this day"}
              description="Your room's habits show up here once an admin adds them."
            />
          </Card>
        )}

        {rows !== null && rows.length > 0 && groups !== null &&
          groups.map((group) => (
            <section key={group.category ?? "uncategorized"} className="space-y-2">
              <CategoryHeading category={group.category} />
              <HabitRows habits={group.habits} toggleProps={roomToggleProps} />
            </section>
          ))}

        {rows !== null && rows.length > 0 && groups === null && (
          <HabitRows habits={rows} toggleProps={roomToggleProps} />
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
            categoriesEnabled={categoriesEnabled}
            toggleProps={personalToggleProps}
            onLogged={onLogged}
            onListChanged={onPersonalHabitsChanged}
          />
        )}
      </div>
    </div>
  );
}
