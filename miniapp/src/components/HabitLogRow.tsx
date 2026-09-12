import { useEffect, useState } from "react";
import { messageForApiError } from "../api/errors.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

/** Must stay in sync with salawat-bot MAX_HABIT_VALUE. */
export const MAX_HABIT_VALUE = 10_000;

interface CommonProps {
  name: string;
  /**
   * The room habit's weight, used for the points preview. Omitted for a
   * personal habit, which has no points at all — and then no points line is
   * drawn rather than a zero being shown.
   */
  pointsWeight?: number;
  logged: boolean;
}

interface QuantityProps extends CommonProps {
  value: number;
  onSave: (value: number) => Promise<void>;
}

/** A number plus an explicit Save — the same row for a room and a personal habit. */
export function QuantityHabitRow({
  name,
  pointsWeight,
  value: savedValue,
  logged,
  onSave,
}: QuantityProps) {
  const [value, setValue] = useState(String(savedValue));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValue(String(savedValue));
  }, [savedValue]);

  const parsed = Number(value);
  const isValid =
    value.trim().length > 0 &&
    Number.isInteger(parsed) &&
    parsed >= 0 &&
    parsed <= MAX_HABIT_VALUE;
  const unchanged = isValid && parsed === savedValue;

  async function handleSave() {
    if (saving || !isValid || unchanged) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(parsed);
    } catch (err) {
      setError(messageForApiError(err, "Couldn't save that — please try again."));
    } finally {
      setSaving(false);
    }
  }

  const hints: string[] = [];
  if (!isValid) hints.push("Enter a whole number");
  else if (pointsWeight !== undefined) {
    hints.push(`= ${(parsed * pointsWeight).toLocaleString()} pts`);
  }
  if (logged) hints.push("logged today");

  return (
    <div className="space-y-2 px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-foreground">{name}</span>
        {pointsWeight !== undefined && (
          <span className="text-xs text-muted-foreground">× {pointsWeight} pts</span>
        )}
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
          aria-label={`${name} value`}
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
      <p className="text-xs text-muted-foreground">{hints.join(" · ")}</p>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

interface BinaryProps extends CommonProps {
  onToggle: (checked: boolean) => Promise<void>;
}

/** A switch, both ways — log on, unlog off. */
export function BinaryHabitRow({ name, pointsWeight, logged, onToggle }: BinaryProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleToggle(checked: boolean) {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onToggle(checked);
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
          <p className="text-sm font-medium text-foreground">{name}</p>
          {pointsWeight !== undefined && (
            <p className="text-xs text-muted-foreground">{pointsWeight} pts when done</p>
          )}
        </div>
        <Switch
          checked={logged}
          disabled={saving}
          onCheckedChange={(checked) => void handleToggle(checked)}
        />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
