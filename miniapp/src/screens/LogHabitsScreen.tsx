import { Layers } from "lucide-react";
import { deleteHabitLog, logHabit } from "../api/client.ts";
import type {
  Habit,
  HabitCategory,
  PersonalHabit,
  RegisteredProgress,
  TodayHabitEntry,
} from "../api/types.ts";
import { hapticMedium } from "../lib/haptics.ts";
import { CATEGORY_META, groupHabitsByCategory } from "../lib/habitCategories.ts";
import { BinaryHabitRow, QuantityHabitRow } from "../components/HabitLogRow.tsx";
import PersonalHabits from "../components/PersonalHabits.tsx";
import { Card, CardContent } from "@/components/ui/card";

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

function findEntry(today: TodayHabitEntry[], habitId: number): TodayHabitEntry | undefined {
  return today.find((entry) => entry.habitId === habitId);
}

interface HabitRowsProps {
  initData: string;
  habits: Habit[];
  progress: RegisteredProgress;
  onLogged: () => void;
}

/** One card of habit rows — the whole list when categories are off, one group when on. */
function HabitRows({ initData, habits, progress, onLogged }: HabitRowsProps) {
  return (
    <Card>
      <CardContent className="divide-y p-0">
        {habits.map((habit) => {
          const entry = findEntry(progress.today, habit.id);
          return habit.type === "quantity" ? (
            <QuantityHabitRow
              key={habit.id}
              name={habit.name}
              pointsWeight={habit.pointsWeight}
              value={entry?.value ?? 0}
              logged={entry?.logged ?? false}
              onSave={async (value) => {
                await logHabit(initData, habit.id, value);
                hapticMedium();
                onLogged();
              }}
            />
          ) : (
            <BinaryHabitRow
              key={habit.id}
              name={habit.name}
              pointsWeight={habit.pointsWeight}
              logged={entry?.logged ?? false}
              onToggle={async (checked) => {
                if (checked) await logHabit(initData, habit.id);
                else await deleteHabitLog(initData, habit.id);
                hapticMedium();
                onLogged();
              }}
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
  // Grouping is the room's choice, not the habit's: a room with categories off
  // shows the same flat list it always did, even though the habits may still
  // carry a stored category (PRD §0).
  const categoriesEnabled = progress.room?.categoriesEnabled ?? false;
  const groups = categoriesEnabled && habits !== null ? groupHabitsByCategory(habits) : null;

  return (
    <div className="mx-auto max-w-sm space-y-4 px-4 py-6">
      <h2 className="text-lg font-semibold text-foreground">Log today's habits</h2>

      {habits === null && <p className="text-sm text-muted-foreground">Loading…</p>}

      {habits !== null && habits.length === 0 && (
        <p className="text-sm text-muted-foreground">No active habits yet.</p>
      )}

      {habits !== null && habits.length > 0 && groups !== null && (
        <div className="space-y-5">
          {groups.map((group) => (
            <section key={group.category ?? "uncategorized"} className="space-y-2">
              <CategoryHeading category={group.category} />
              <HabitRows
                initData={initData}
                habits={group.habits}
                progress={progress}
                onLogged={onLogged}
              />
            </section>
          ))}
        </div>
      )}

      {habits !== null && habits.length > 0 && groups === null && (
        <HabitRows
          initData={initData}
          habits={habits}
          progress={progress}
          onLogged={onLogged}
        />
      )}

      {/* The member's own list, always last and always one block — even in a
          categories-enabled room, where the room's habits above are grouped. */}
      <PersonalHabits
        initData={initData}
        habits={personalHabits}
        today={progress.personalToday}
        categoriesEnabled={categoriesEnabled}
        onLogged={onLogged}
        onListChanged={onPersonalHabitsChanged}
      />
    </div>
  );
}
