import { useEffect, useState } from "react";
import { deleteHabitLog, logHabit } from "../api/client.ts";
import { messageForApiError } from "../api/errors.ts";
import type { Habit, RegisteredProgress, TodayHabitEntry } from "../api/types.ts";
import { hapticMedium } from "../lib/haptics.ts";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

/** Must stay in sync with salawat-bot MAX_HABIT_VALUE. */
const MAX_HABIT_VALUE = 10_000;

interface Props {
  initData: string;
  habits: Habit[] | null;
  progress: RegisteredProgress;
  /** Called after a successful log/unlog so the caller can refresh shared progress state. */
  onLogged: () => void;
}

function findEntry(today: TodayHabitEntry[], habitId: number): TodayHabitEntry | undefined {
  return today.find((entry) => entry.habitId === habitId);
}

interface QuantityRowProps {
  initData: string;
  habit: Habit;
  entry: TodayHabitEntry | undefined;
  onLogged: () => void;
}

function QuantityHabitRow({ initData, habit, entry, onLogged }: QuantityRowProps) {
  const [value, setValue] = useState(String(entry?.value ?? 0));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValue(String(entry?.value ?? 0));
  }, [entry?.value]);

  const parsed = Number(value);
  const isValid = value.trim().length > 0 && Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_HABIT_VALUE;
  const unchanged = isValid && parsed === (entry?.value ?? 0);

  async function handleSave() {
    if (saving || !isValid || unchanged) return;
    setSaving(true);
    setError(null);
    try {
      await logHabit(initData, habit.id, parsed);
      hapticMedium();
      onLogged();
    } catch (err) {
      setError(messageForApiError(err, "Couldn't save that — please try again."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2 px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-foreground">{habit.name}</span>
        <span className="text-xs text-muted-foreground">× {habit.pointsWeight} pts</span>
      </div>
      <div className="flex items-center gap-2">
        <Input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          value={value}
          disabled={saving}
          onChange={(e) => setValue(e.target.value)}
          className="h-11 flex-1 text-base tabular-nums"
          aria-label={`${habit.name} value`}
        />
        <Button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || !isValid || unchanged}
          className="shrink-0"
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {isValid ? `= ${(parsed * habit.pointsWeight).toLocaleString()} pts` : "Enter a whole number"}
        {entry?.logged ? " · logged today" : ""}
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

interface BinaryRowProps {
  initData: string;
  habit: Habit;
  entry: TodayHabitEntry | undefined;
  onLogged: () => void;
}

function BinaryHabitRow({ initData, habit, entry, onLogged }: BinaryRowProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logged = entry?.logged ?? false;

  async function handleToggle(checked: boolean) {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      if (checked) {
        await logHabit(initData, habit.id);
      } else {
        await deleteHabitLog(initData, habit.id);
      }
      hapticMedium();
      onLogged();
    } catch (err) {
      setError(messageForApiError(err, "Couldn't update that — please try again."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-1.5 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-foreground">{habit.name}</p>
          <p className="text-xs text-muted-foreground">{habit.pointsWeight} pts when done</p>
        </div>
        <Switch checked={logged} disabled={saving} onCheckedChange={(checked) => void handleToggle(checked)} />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

export default function LogHabitsScreen({ initData, habits, progress, onLogged }: Props) {
  return (
    <div className="mx-auto max-w-sm space-y-4 px-4 py-6">
      <h2 className="text-lg font-semibold text-foreground">Log today's habits</h2>

      {habits === null && <p className="text-sm text-muted-foreground">Loading…</p>}

      {habits !== null && habits.length === 0 && (
        <p className="text-sm text-muted-foreground">No active habits yet.</p>
      )}

      {habits !== null && habits.length > 0 && (
        <Card>
          <CardContent className="divide-y p-0">
            {habits.map((habit) =>
              habit.type === "quantity" ? (
                <QuantityHabitRow
                  key={habit.id}
                  initData={initData}
                  habit={habit}
                  entry={findEntry(progress.today, habit.id)}
                  onLogged={onLogged}
                />
              ) : (
                <BinaryHabitRow
                  key={habit.id}
                  initData={initData}
                  habit={habit}
                  entry={findEntry(progress.today, habit.id)}
                  onLogged={onLogged}
                />
              )
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
